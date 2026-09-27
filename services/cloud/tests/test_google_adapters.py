import json
from dataclasses import replace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from google.api_core.exceptions import AlreadyExists, NotFound

from services.cloud.config import Settings
from services.cloud.google import GoogleObjects, GoogleTasks
from services.cloud.worker import create_app


def test_queue_delivery_uses_private_oidc_identity_and_stable_task_name(monkeypatch):
    client = Mock()
    client.queue_path.return_value = "projects/test/locations/us-central1/queues/video-analysis"
    monkeypatch.setattr("services.cloud.google.tasks_v2.CloudTasksClient", lambda: client)
    settings = Settings(project_id="test", worker_url="https://worker.run.app/",
                        task_identity="tasks@test.iam.gserviceaccount.com")
    queue = GoogleTasks(settings)
    job_id = str(uuid4())
    queue.enqueue(job_id)
    task = client.create_task.call_args.kwargs["task"]
    assert task.name.endswith(f"/tasks/{job_id}")
    assert task.dispatch_deadline.total_seconds() == 1800
    assert task.http_request.url == "https://worker.run.app/internal/process"
    assert task.http_request.oidc_token.audience == "https://worker.run.app"
    assert task.http_request.oidc_token.service_account_email == settings.task_identity
    assert json.loads(task.http_request.body) == {"job_id": job_id}
    client.create_task.side_effect = AlreadyExists("already queued")
    queue.enqueue(job_id)
    client.delete_task.side_effect = NotFound("already finished")
    queue.cancel(job_id)
    queue.settings = replace(settings, worker_url="http://localhost:8080")
    with pytest.raises(ValueError):
        queue.enqueue(job_id)


def objects(monkeypatch):
    credentials, client = Mock(), Mock()
    credentials.token = "short-lived-identity-token"
    monkeypatch.setattr("services.cloud.google.google.auth.default", lambda **kwargs: (credentials, "test"))
    monkeypatch.setattr("services.cloud.google.storage.Client", lambda **kwargs: client)
    return GoogleObjects(Settings(project_id="test", bucket="private-media",
                                  signer_identity="api@test.iam.gserviceaccount.com")), client.bucket.return_value


def test_signed_urls_bind_upload_headers_and_download_generation(monkeypatch):
    adapter, bucket = objects(monkeypatch)
    adapter.upload_url("source/video.mp4", "video/mp4")
    signed = bucket.blob.return_value.generate_signed_url.call_args.kwargs
    assert signed["method"] == "PUT"
    assert signed["headers"] == {"x-goog-if-generation-match": "0"}
    assert signed["content_type"] == "video/mp4"
    assert signed["expiration"].total_seconds() == 900
    assert signed["service_account_email"] == adapter.settings.signer_identity
    adapter.result_url("result/output.json", 17)
    signed = bucket.blob.return_value.generate_signed_url.call_args.kwargs
    assert signed["method"] == "GET" and signed["generation"] == 17


def test_storage_download_is_generation_pinned_and_size_checked(monkeypatch, tmp_path):
    adapter, bucket = objects(monkeypatch)
    path = tmp_path / "video"
    path.write_bytes(b"test")
    adapter.download("source/video.mp4", 17, path, 4)
    bucket.blob.assert_called_with("source/video.mp4", generation=17)
    arguments = bucket.blob.return_value.download_to_filename.call_args.kwargs
    assert arguments["if_generation_match"] == 17
    assert arguments["start"] == 0 and arguments["end"] == 3
    assert arguments["raw_download"] is True
    with pytest.raises(ValueError):
        adapter.download("source/video.mp4", 17, path, 5)


def test_results_are_immutable_and_size_bounded(monkeypatch):
    adapter, bucket = objects(monkeypatch)
    adapter.write_result("result/output.json", {"text": "example"})
    assert bucket.blob.return_value.upload_from_string.call_args.kwargs["if_generation_match"] == 0
    with pytest.raises(ValueError):
        adapter.write_result("result/oversize.json", {"text": "x" * (1024 * 1024)})


def test_worker_accepts_only_job_ids_not_client_urls_or_prompts():
    runner = Mock()
    runner.service.settings.execution_timeout_seconds = 1500
    runner.process.return_value = {"accepted": True, "status": "succeeded"}
    job_id = str(uuid4())
    with TestClient(create_app(runner)) as client:
        assert client.post("/internal/process", json={"job_id": job_id}).status_code == 200
        runner.process.assert_called_once_with(job_id)
        assert client.post("/internal/process", json={"job_id": job_id, "url": "https://example.com"}).status_code == 422
        assert client.post("/internal/process", json={"job_id": "invalid"}).status_code == 422
        assert client.get("/openapi.json").status_code == 404

