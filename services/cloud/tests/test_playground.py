from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from scripts.playground import API_URL, BUCKET, MAX_BYTES, CloudClient, LocalError, create_app, validate_storage_url


class FakeCloud:
    def __init__(self, enabled=True):
        self.enabled = enabled
        self.asset_id = str(uuid4())
        self.job_id = str(uuid4())
        self.calls = []
        self.uploaded = b""

    async def api(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        if path == "/health":
            return {"status": "ok", "analysis_enabled": self.enabled, "model": "allenai/Molmo2-8B"}
        if path == "/v1/assets":
            return {"asset": {"id": self.asset_id}, "upload": {
                "url": f"https://storage.googleapis.com/{BUCKET}/source/pilot/video?signature=secret",
                "headers": {"content-type": "video/mp4", "x-goog-if-generation-match": "0"},
            }}
        if path.endswith("/complete"):
            return {"asset": {"id": self.asset_id, "status": "ready"}}
        if method == "DELETE":
            return {}
        return {"job": {"id": self.job_id, "status": "succeeded"}, "replayed": False}

    async def upload(self, url, headers, content):
        assert headers["x-goog-if-generation-match"] == "0"
        async for part in content:
            self.uploaded += part

    async def result(self, job_id):
        return {"job_id": job_id, "output": {"text": "A penguin on ice."}, "metrics": {"worker_ms": 3144}}


def client_for(cloud=None):
    client = TestClient(create_app(cloud or FakeCloud(), sample=Path("/nonexistent/video.mp4")),
                        base_url="http://127.0.0.1:3000")
    token = client.get("/api/session").json()["token"]
    client.headers["X-Playground-Token"] = token
    return client


def test_static_session_and_csp_do_not_expose_credentials():
    client = client_for()
    response = client.get("/")
    assert response.status_code == 200
    assert "Tayra Labs · Playground" in response.text
    assert "Molmo2-8B" in response.text
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/app.js").status_code == 200
    assert client.get("/styles.css").status_code == 200
    session = client.get("/api/session").json()
    assert "key" not in session and "identity" not in session
    assert session["sample_available"] is False
    assert client.get("/sample/video").status_code == 404


def test_company_logo_is_local_and_does_not_contact_cloud():
    cloud = FakeCloud(enabled=False)
    client = client_for(cloud)
    response = client.get("/tayra-logo.svg")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert "<title id=\"title\">Tayra logo</title>" in response.text
    assert "<script" not in response.text
    assert cloud.calls == []


@pytest.mark.parametrize("headers", [
    {"Origin": "https://evil.example"}, {"Host": "evil.example:3000"},
    {"Sec-Fetch-Site": "cross-site"}, {"X-Playground-Token": "wrong"},
])
def test_rejects_foreign_or_unauthenticated_requests(headers):
    cloud = FakeCloud()
    client = client_for(cloud)
    assert client.get("/api/health", headers=headers).status_code == 403
    assert cloud.calls == []


def test_paused_api_blocks_upload_registration_without_writing():
    cloud = FakeCloud(enabled=False)
    client = client_for(cloud)
    response = client.post("/api/assets", json={"filename": "test.mp4", "content_type": "video/mp4", "size_bytes": 4})
    assert response.status_code == 503
    assert cloud.calls == [("GET", "/health", {})]
    assert client.get(f"/api/jobs/{cloud.job_id}/result").status_code == 200
    assert all("run.googleapis.com" not in call[1] for call in cloud.calls)


def test_upload_job_result_and_cancellation_flow_preserves_key_and_hides_signed_url():
    cloud = FakeCloud()
    client = client_for(cloud)
    created = client.post("/api/assets", json={"filename": "test.mp4", "content_type": "video/mp4", "size_bytes": 4})
    assert created.status_code == 201
    assert "upload" not in created.json() and "signature" not in created.text
    assert client.put(f"/api/assets/{cloud.asset_id}/content", content=b"test").json()["asset"]["status"] == "ready"
    assert cloud.uploaded == b"test"
    body = {"asset_id": cloud.asset_id, "prompt": "Describe it.", "max_new_tokens": 256}
    key = str(uuid4())
    response = client.post("/api/jobs", json=body, headers={"Idempotency-Key": key})
    assert response.status_code == 202
    assert cloud.calls[-1] == ("POST", "/v1/jobs", {"body": body, "idempotency_key": key})
    client.post("/api/jobs", json=body, headers={"Idempotency-Key": key})
    assert cloud.calls[-1][2]["idempotency_key"] == key
    assert client.get(f"/api/jobs/{cloud.job_id}").status_code == 200
    assert client.get(f"/api/jobs/{cloud.job_id}/result").json()["output"]["text"] == "A penguin on ice."
    assert client.post(f"/api/jobs/{cloud.job_id}/cancel").status_code == 202
    assert client.delete(f"/api/assets/{cloud.asset_id}").status_code == 204


def test_upload_size_and_registration_are_enforced():
    cloud = FakeCloud()
    client = client_for(cloud)
    assert client.put(f"/api/assets/{uuid4()}/content", content=b"test").status_code == 410
    client.post("/api/assets", json={"filename": "test.mp4", "content_type": "video/mp4", "size_bytes": 4})
    assert client.put(f"/api/assets/{cloud.asset_id}/content", content=b"wrong-size").status_code == 400
    assert cloud.uploaded == b""
    assert client.post("/api/assets", json={"filename": "x.mp4", "content_type": "video/mp4", "size_bytes": MAX_BYTES + 1}).status_code == 422
    assert client.post("/api/assets", json={"filename": "x.txt", "content_type": "text/plain", "size_bytes": 4}).status_code == 400


def test_elanus_alias_is_validated_and_translated_for_legacy_cloud_api():
    cloud = FakeCloud()
    client = client_for(cloud)
    session = client.get("/api/session").json()
    assert session["model"] == "elanus-1-8b"
    assert session["checkpoint"] == "allenai/Molmo2-8B"
    body = {"asset_id": cloud.asset_id, "model": "elanus-1-8b", "prompt": "Describe", "max_new_tokens": 256}
    headers = {"Idempotency-Key": "same-request"}
    assert client.post("/api/jobs", json=body, headers=headers).status_code == 202
    assert cloud.calls[-1][2] == {"body": {k: v for k, v in body.items() if k != "model"},
                                "idempotency_key": "same-request"}
    cloud.calls.clear()
    body["model"] = "unknown-model"
    assert client.post("/api/jobs", json=body, headers=headers).status_code == 422
    assert cloud.calls == []


def test_json_body_limit_and_job_validation():
    cloud = FakeCloud()
    client = client_for(cloud)
    assert client.post("/api/jobs", content=b"x" * 32769).status_code == 413
    assert client.post("/api/jobs", json={"asset_id": "bad", "prompt": "x"}).status_code == 422
    assert client.post("/api/jobs", json={"asset_id": str(uuid4()), "prompt": "x"},
                       headers={"Idempotency-Key": " "}).status_code == 400
    assert client.get("/api/jobs/not-a-uuid").status_code == 422
    assert cloud.calls == []


@pytest.mark.parametrize("url", [
    "http://storage.googleapis.com/bucket/secret", "https://evil.example/file",
    f"https://storage.googleapis.com/{BUCKET}-other/file", "http://169.254.169.254/metadata",
    f"https://user:pass@storage.googleapis.com/{BUCKET}/file",
])
def test_storage_urls_are_restricted(url):
    with pytest.raises(LocalError):
        validate_storage_url(url)


def test_storage_url_allows_only_existing_private_bucket():
    url = f"https://storage.googleapis.com/{BUCKET}/results/pilot/result.json?signature=secret"
    assert validate_storage_url(url) == url


def test_sample_preview_is_local_and_does_not_contact_cloud(tmp_path):
    sample = tmp_path / "sample.mp4"
    sample.write_bytes(b"video-test")
    cloud = FakeCloud()
    client = TestClient(create_app(cloud, sample=sample), base_url="http://127.0.0.1:3000")
    assert client.get("/sample/video").content == b"video-test"
    assert cloud.calls == []


def test_cloud_client_uses_both_credentials_without_forwarding_browser_input(monkeypatch):
    seen = []
    async def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"status": "ok"})
    real_client = httpx.AsyncClient
    monkeypatch.setattr("scripts.playground.httpx.AsyncClient", lambda **kwargs:
                        real_client(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(CloudClient, "_credentials", staticmethod(lambda: ("google-secret", "pilot-secret")))
    client = client_for(CloudClient())
    response = client.get("/api/health")
    assert response.json() == {"status": "ok"}
    assert seen[0].url == API_URL + "/health"
    assert seen[0].headers["authorization"] == "Bearer pilot-secret"
    assert seen[0].headers["x-serverless-authorization"] == "Bearer google-secret"
    assert "secret" not in response.text
