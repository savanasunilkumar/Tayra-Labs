from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import google.auth
from google.api_core.exceptions import AlreadyExists, NotFound
from google.auth.transport.requests import Request
from google.cloud import firestore, storage, tasks_v2
from google.cloud.firestore_v1.base_query import FieldFilter
from google.protobuf import duration_pb2

from .config import Settings
from .ports import Document, T


class FirestoreTransaction:
    def __init__(self, client, transaction):
        self.client, self.transaction = client, transaction

    def get(self, collection: str, key: str) -> Document | None:
        snapshot = self.client.collection(collection).document(key).get(transaction=self.transaction)
        return snapshot.to_dict() if snapshot.exists else None

    def put(self, collection: str, key: str, value: Document) -> None:
        self.transaction.set(self.client.collection(collection).document(key), value)


class FirestoreStore:
    def recent_jobs(self, tenant: str, limit: int = 30) -> list[Document]:
        query = (self.client.collection("jobs").where(filter=FieldFilter("tenant_id", "==", tenant))
                 .order_by("created_at", direction=firestore.Query.DESCENDING).limit(limit))
        return [snapshot.to_dict() for snapshot in query.stream()]

    def __init__(self, settings: Settings):
        self.client = firestore.Client(project=settings.project_id, database=settings.database)

    def get(self, collection: str, key: str) -> Document | None:
        snapshot = self.client.collection(collection).document(key).get()
        return snapshot.to_dict() if snapshot.exists else None

    def transact(self, operation) -> T:
        @firestore.transactional
        def run(transaction):
            return operation(FirestoreTransaction(self.client, transaction))
        return run(self.client.transaction())

    def find(self, collection: str, field: str, operator: str, value: Any, limit: int = 100) -> list[Document]:
        query = self.client.collection(collection).where(filter=FieldFilter(field, operator, value)).limit(limit)
        return [snapshot.to_dict() for snapshot in query.stream()]


class GoogleObjects:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        self.client = storage.Client(project=settings.project_id, credentials=self.credentials)
        self.bucket = self.client.bucket(settings.bucket)

    def _sign(self, key: str, method: str, **kwargs) -> str:
        # Cloud Run uses IAM signBlob with its attached identity; no downloaded private key.
        self.credentials.refresh(Request())
        return self.bucket.blob(key).generate_signed_url(
            version="v4", expiration=timedelta(minutes=15), method=method,
            service_account_email=self.settings.signer_identity,
            access_token=self.credentials.token, **kwargs,
        )

    def upload_url(self, key: str, content_type: str) -> str:
        return self._sign(key, "PUT", content_type=content_type,
                          headers={"x-goog-if-generation-match": "0"})

    def result_url(self, key: str, generation: int) -> str:
        return self._sign(key, "GET", generation=generation)

    def head(self, key: str) -> Document | None:
        blob = self.bucket.get_blob(key, timeout=30)
        if blob is None:
            return None
        return {"size": blob.size, "content_type": blob.content_type, "generation": int(blob.generation)}

    def download(self, key: str, generation: int, path: Path, size: int) -> None:
        # Pin the validated generation and bound the range even if bucket permissions drift.
        blob = self.bucket.blob(key, generation=generation)
        blob.download_to_filename(str(path), start=0, end=size - 1, timeout=300,
                                  if_generation_match=generation, raw_download=True)
        if path.stat().st_size != size:
            raise ValueError("Source size changed after upload validation")

    def write_result(self, key: str, value: Document) -> None:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
        if len(encoded) > 1024 * 1024:
            raise ValueError("Result exceeds 1 MiB")
        self.bucket.blob(key).upload_from_string(encoded, content_type="application/json",
                                                if_generation_match=0, timeout=120)

    def read_result(self, key: str) -> Document | None:
        metadata = self.head(key)
        if metadata is None:
            return None
        if metadata["size"] > 1024 * 1024:
            raise ValueError("Result exceeds 1 MiB")
        blob = self.bucket.blob(key, generation=metadata["generation"])
        value = json.loads(blob.download_as_bytes(timeout=30, if_generation_match=metadata["generation"]))
        if not isinstance(value, dict):
            raise ValueError("Result must be an object")
        return value

    def delete(self, key: str) -> None:
        try:
            self.bucket.blob(key).delete(timeout=30)
        except NotFound:
            pass


class GoogleTasks:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = tasks_v2.CloudTasksClient()
        self.parent = self.client.queue_path(settings.project_id, settings.region, settings.queue)

    def enqueue(self, job_id: str) -> None:
        if not self.settings.worker_url.startswith("https://"):
            raise ValueError("WORKER_URL must be a deployed HTTPS Cloud Run URL")
        task = tasks_v2.Task(
            name=f"{self.parent}/tasks/{job_id}",
            dispatch_deadline=duration_pb2.Duration(seconds=1800),
            http_request=tasks_v2.HttpRequest(
                http_method=tasks_v2.HttpMethod.POST,
                url=f"{self.settings.worker_url.rstrip('/')}/internal/process",
                headers={"Content-Type": "application/json"},
                body=json.dumps({"job_id": job_id}).encode(),
                oidc_token=tasks_v2.OidcToken(
                    service_account_email=self.settings.task_identity,
                    audience=self.settings.worker_url.rstrip("/"),
                ),
            ),
        )
        try:
            self.client.create_task(parent=self.parent, task=task, timeout=20)
        except AlreadyExists:
            pass  # The UUID is stable across ambiguous enqueue failures and client retries.

    def cancel(self, job_id: str) -> None:
        try:
            self.client.delete_task(name=f"{self.parent}/tasks/{job_id}", timeout=20)
        except NotFound:
            pass
