from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Callable
from uuid import uuid4

from .config import API_MODEL_ID, MODEL_ID, MODEL_REVISION, Settings
from .ports import Document, Objects, Store, Tasks, Transaction

TERMINAL = {"succeeded", "failed", "timed_out", "cancelled"}
VIDEO_TYPES = {"video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm"}
log = logging.getLogger(__name__)


class Problem(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message
        super().__init__(message)


def owned(document: Document | None, tenant: str, noun: str) -> Document:
    if document is None or document.get("tenant_id") != tenant:
        raise Problem(404, f"{noun}_not_found", f"{noun.capitalize()} not found")
    return document


def public_asset(asset: Document) -> Document:
    return {key: asset.get(key) for key in (
        "id", "filename", "content_type", "expected_bytes", "actual_bytes", "status",
        "created_at", "retention_until",
    )}


def public_job(job: Document) -> Document:
    return {key: job.get(key) for key in (
        "id", "asset_id", "filename", "model", "model_id", "model_revision", "mode", "status", "created_at",
        "updated_at", "completed_at", "result_expires_at", "error", "metrics",
    )}


class Service:
    def __init__(self, settings: Settings, store: Store, objects: Objects, tasks: Tasks,
                 clock: Callable[[], float] = time.time):
        self.settings, self.store, self.objects, self.tasks, self.clock = settings, store, objects, tasks, clock

    def asset(self, asset_id: str, tenant: str = "pilot") -> Document:
        return owned(self.store.get("assets", asset_id), tenant, "asset")

    def job(self, job_id: str, tenant: str = "pilot") -> Document:
        return owned(self.store.get("jobs", job_id), tenant, "job")

    def create_asset(self, filename: str, content_type: str, size: int, tenant: str = "pilot") -> Document:
        if content_type not in VIDEO_TYPES:
            raise Problem(400, "unsupported_content_type", "Supported video types are MP4, MOV, and WebM")
        if size < 1 or size > self.settings.max_upload_bytes:
            raise Problem(400, "upload_too_large", "Video exceeds the configured upload limit")
        asset_id, now = str(uuid4()), self.clock()
        key = f"source/{tenant}/{asset_id}/original.{VIDEO_TYPES[content_type]}"
        url = self.objects.upload_url(key, content_type)
        asset = dict(id=asset_id, tenant_id=tenant, filename=filename, content_type=content_type,
                     expected_bytes=size, actual_bytes=None, generation=None, object_key=key,
                     status="pending_upload", active_jobs=0, created_at=now, updated_at=now,
                     retention_until=now + self.settings.source_retention_seconds)
        self.store.transact(lambda tx: tx.put("assets", asset_id, asset))
        return {"asset": public_asset(asset), "upload": {
            "method": "PUT", "url": url, "expires_in_seconds": 900,
            "headers": {"content-type": content_type, "x-goog-if-generation-match": "0"},
        }}

    def complete_asset(self, asset_id: str, tenant: str = "pilot") -> Document:
        initial = self.asset(asset_id, tenant)
        metadata = self.objects.head(initial["object_key"])

        def complete(tx: Transaction):
            asset = owned(tx.get("assets", asset_id), tenant, "asset")
            if asset["status"] == "ready":
                return asset
            if asset["status"] != "pending_upload" or asset["retention_until"] <= self.clock():
                raise Problem(409, "invalid_asset_state", "This upload is no longer available")
            if metadata is None:
                raise Problem(409, "upload_missing", "Upload the video before completing the asset")
            if metadata["size"] != asset["expected_bytes"] or metadata["content_type"] != asset["content_type"]:
                raise Problem(409, "upload_mismatch", "Uploaded size or content type does not match")
            asset.update(status="ready", actual_bytes=metadata["size"], generation=metadata["generation"],
                         updated_at=self.clock())
            tx.put("assets", asset_id, asset)
            return asset
        return {"asset": public_asset(self.store.transact(complete))}

    def upload_ticket(self, asset_id: str, tenant: str) -> Document:
        asset = self.asset(asset_id, tenant)
        if asset["status"] != "pending_upload" or asset["retention_until"] <= self.clock():
            raise Problem(409, "invalid_asset_state", "This upload is no longer available")
        return {"asset": public_asset(asset), "upload": {
            "url": self.objects.upload_url(asset["object_key"], asset["content_type"]),
            "headers": {"content-type": asset["content_type"], "x-goog-if-generation-match": "0"},
        }}

    def delete_asset(self, asset_id: str, tenant: str = "pilot") -> None:
        def reserve(tx: Transaction):
            asset = owned(tx.get("assets", asset_id), tenant, "asset")
            if asset["active_jobs"]:
                raise Problem(409, "asset_in_use", "Asset has an active analysis job")
            asset.update(status="deleted", updated_at=self.clock())
            tx.put("assets", asset_id, asset)
            return asset
        asset = self.store.transact(reserve)
        self.objects.delete(asset["object_key"])

    def create_job(self, asset_id: str, prompt: str, max_new_tokens: int, idempotency_key: str,
                   tenant: str = "pilot") -> Document:
        if not self.settings.analysis_enabled:
            raise Problem(503, "analysis_unavailable", "Analysis is disabled; uploads remain available")
        if (self.settings.model_id, self.settings.model_revision) != (MODEL_ID, MODEL_REVISION):
            raise Problem(503, "model_unavailable", "The configured checkpoint does not match Elanus 1 · 8B")
        request_hash = hashlib.sha256(json.dumps([asset_id, prompt, max_new_tokens]).encode()).hexdigest()
        idempotency_id = hashlib.sha256(f"{tenant}:{idempotency_key}".encode()).hexdigest()
        job_id, now = str(uuid4()), self.clock()

        def reserve(tx: Transaction):
            prior = tx.get("idempotency", idempotency_id)
            if prior is not None:
                if prior["request_hash"] != request_hash:
                    raise Problem(409, "idempotency_conflict", "Key was used with a different request")
                return owned(tx.get("jobs", prior["job_id"]), tenant, "job"), True
            asset = owned(tx.get("assets", asset_id), tenant, "asset")
            tenant_state = tx.get("tenants", tenant) or {"active_jobs": 0}
            if asset["status"] != "ready" or asset["retention_until"] <= now:
                raise Problem(409, "asset_not_ready", "Complete an unexpired upload before creating a job")
            if tenant_state["active_jobs"] >= self.settings.max_active_jobs:
                raise Problem(429, "job_limit", "Too many active analysis jobs")
            job = dict(id=job_id, tenant_id=tenant, asset_id=asset_id, filename=asset["filename"], prompt=prompt, mode="standard",
                       max_new_tokens=max_new_tokens, model=API_MODEL_ID, model_id=self.settings.model_id,
                       model_revision=self.settings.model_revision, source_key=asset["object_key"],
                       source_generation=asset["generation"], source_size=asset["actual_bytes"],
                       result_key=f"result/{tenant}/{job_id}/result.json", status="submitting",
                       created_at=now, updated_at=now, queue_expires_at=now + self.settings.queue_timeout_seconds,
                       lease_until=None, started_at=None, completed_at=None, result_expires_at=None,
                       result_deleted=False, metrics=None, error=None)
            asset["active_jobs"] += 1
            tenant_state["active_jobs"] += 1
            tx.put("assets", asset_id, asset)
            tx.put("tenants", tenant, tenant_state)
            tx.put("jobs", job_id, job)
            tx.put("idempotency", idempotency_id, {"job_id": job_id, "request_hash": request_hash})
            return job, False

        job, replayed = self.store.transact(reserve)
        if job["status"] == "submitting":
            self.enqueue(job)
            job = self.job(job["id"], tenant)
        return {"job": public_job(job), "replayed": replayed}

    def enqueue(self, job: Document) -> None:
        try:
            self.tasks.enqueue(job["id"])
        except Exception:
            # Leave the durable outbox in submitting. The same request or maintenance retries the same task UUID.
            log.warning("Queue submission pending for job %s", job["id"])
            raise Problem(503, "queue_unavailable", "Submission is saved; retry with the same Idempotency-Key") from None

        def mark(tx: Transaction):
            current = tx.get("jobs", job["id"])
            if current is not None and current["status"] == "submitting":
                current.update(status="queued", updated_at=self.clock())
                tx.put("jobs", current["id"], current)
        self.store.transact(mark)

    def claim(self, job_id: str) -> Document | None:
        self.reconcile(job_id)

        def claim(tx: Transaction):
            job = tx.get("jobs", job_id)
            if job is None or job["status"] in TERMINAL:
                return None
            if job["status"] in {"running", "cancel_requested"}:
                raise Problem(503, "job_busy", "Another delivery owns this job")
            now = self.clock()
            if job["queue_expires_at"] <= now:
                return None
            job.update(status="running", started_at=now, updated_at=now,
                       lease_until=now + self.settings.lease_seconds)
            tx.put("jobs", job_id, job)
            tx.put("attempts", job_id, dict(job_id=job_id, tenant_id=job["tenant_id"],
                                           status="running", started_at=now))
            return job
        return self.store.transact(claim)

    def finish(self, job_id: str, status: str, metrics: Document | None = None,
               error: Document | None = None) -> Document:
        if status not in TERMINAL:
            raise ValueError("Finish requires a terminal status")
        now = self.clock()

        def finish(tx: Transaction):
            job = tx.get("jobs", job_id)
            if job is None:
                raise Problem(404, "job_not_found", "Job not found")
            if job["status"] in TERMINAL:
                return job
            asset = tx.get("assets", job["asset_id"])
            tenant_state = tx.get("tenants", job["tenant_id"])
            attempt = tx.get("attempts", job_id)
            final_status = "cancelled" if job["status"] == "cancel_requested" else status
            job.update(status=final_status, metrics=metrics, error=error, completed_at=now, updated_at=now,
                       result_expires_at=now + self.settings.result_retention_seconds)
            if asset is not None:
                asset["active_jobs"] = max(0, asset["active_jobs"] - 1)
                tx.put("assets", asset["id"], asset)
            if tenant_state is not None:
                tenant_state["active_jobs"] = max(0, tenant_state["active_jobs"] - 1)
                tx.put("tenants", job["tenant_id"], tenant_state)
            tx.put("jobs", job_id, job)
            if attempt is not None:
                attempt.update(status=final_status, completed_at=now, metrics=metrics, error=error)
                tx.put("attempts", job_id, attempt)
                tx.put("usage", job_id, dict(job_id=job_id, tenant_id=job["tenant_id"], status=final_status,
                                            metrics=metrics, created_at=now,
                                            measurement="measured" if metrics else "incomplete"))
            return job
        return self.store.transact(finish)

    def cancel(self, job_id: str, tenant: str = "pilot") -> Document:
        def reserve(tx: Transaction):
            job = owned(tx.get("jobs", job_id), tenant, "job")
            previous = job["status"]
            if previous not in TERMINAL:
                job.update(status="cancel_requested", updated_at=self.clock())
                tx.put("jobs", job_id, job)
            return job, previous
        job, previous = self.store.transact(reserve)
        if previous in TERMINAL:
            return public_job(job)
        if previous in {"queued", "submitting"}:
            job = self.finish(job_id, "cancelled")
        # Deleting a task does not stop a running CUDA call. Running cancellation completes at a safe boundary.
        try:
            self.tasks.cancel(job_id)
        except Exception:
            log.warning("Task deletion pending for cancelled job %s", job_id)
        return public_job(job)

    def reconcile(self, job_id: str) -> Document | None:
        job = self.store.get("jobs", job_id)
        if job is None or job["status"] in TERMINAL:
            return job
        if job["status"] == "cancel_requested" and job["started_at"] is None:
            # Recover a crash between recording queued cancellation and releasing its reservation.
            return self.finish(job_id, "cancelled")
        if job["status"] in {"running", "cancel_requested"}:
            result = self.objects.read_result(job["result_key"])
            if result is not None:
                if any(result.get(key) != job[key] for key in ("model_id", "model_revision")) or result.get("job_id") != job_id:
                    return self.finish(job_id, "failed", error={"code": "invalid_result", "message": "Result identity mismatch"})
                return self.finish(job_id, "succeeded", result.get("metrics"))
            if job["lease_until"] is not None and job["lease_until"] <= self.clock():
                return self.finish(job_id, "timed_out", error={"code": "execution_timeout", "message": "Worker deadline exceeded"})
        elif job["queue_expires_at"] <= self.clock():
            return self.finish(job_id, "timed_out", error={"code": "queue_timeout", "message": "Queue deadline exceeded"})
        return job

    def result(self, job_id: str, tenant: str = "pilot") -> Document:
        job = self.job(job_id, tenant)
        if job["status"] != "succeeded":
            raise Problem(409, "result_not_ready", "Job has not succeeded")
        if job["result_deleted"] or job["result_expires_at"] <= self.clock():
            raise Problem(410, "result_expired", "Result has expired")
        metadata = self.objects.head(job["result_key"])
        if metadata is None:
            raise Problem(410, "result_expired", "Result is no longer available")
        return {"job_id": job_id, "result_url": self.objects.result_url(job["result_key"], metadata["generation"]),
                "expires_in_seconds": 900}

    def maintenance(self) -> Document:
        checked = 0
        for status in ("submitting", "queued", "running", "cancel_requested"):
            for job in self.store.find("jobs", "status", "==", status):
                try:
                    updated = self.reconcile(job["id"])
                    if updated and updated["status"] == "submitting":
                        self.enqueue(updated)
                    checked += 1
                except Exception:
                    log.warning("Maintenance retry needed for job %s", job["id"])
        now = self.clock()
        for asset in self.store.find("assets", "retention_until", "<=", now):
            try:
                self.delete_asset(asset["id"], asset["tenant_id"])
                # Exclude completed cleanup from the next bounded scan, without deleting the audit document.
                def clear(tx: Transaction):
                    current = tx.get("assets", asset["id"])
                    if current and current["status"] == "deleted":
                        current.pop("retention_until", None)
                        tx.put("assets", current["id"], current)
                self.store.transact(clear)
            except Problem:
                pass
        for job in self.store.find("jobs", "result_expires_at", "<=", now):
            self.objects.delete(job["result_key"])
            def clear_result(tx: Transaction):
                current = tx.get("jobs", job["id"])
                if current and current["status"] in TERMINAL:
                    current["result_deleted"] = True
                    current.pop("result_expires_at", None)
                    tx.put("jobs", current["id"], current)
            self.store.transact(clear_result)
        return {"checked_jobs": checked}
