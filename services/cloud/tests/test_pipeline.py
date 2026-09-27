from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from services.cloud.api import create_app
from services.cloud.config import API_MODEL_ID, MODEL_ID, MODEL_REVISION, Settings
from services.cloud.runner import Runner
from services.cloud.service import Problem, Service
from services.cloud.tests.fakes import MemoryObjects, MemoryStore, MemoryTasks


@pytest.fixture
def service():
    now = [100000.0]
    value = Service(Settings(api_key="test-key-" + "a" * 32, allow_pilot_key=True), MemoryStore(), MemoryObjects(), MemoryTasks(), lambda: now[0])
    value.test_clock = now
    return value


def ready_asset(service, tenant="pilot"):
    response = service.create_asset("sample.mp4", "video/mp4", 4, tenant)
    asset_id = response["asset"]["id"]
    asset = service.asset(asset_id, tenant)
    service.objects.metadata[asset["object_key"]] = {"size": 4, "generation": 17, "content_type": "video/mp4"}
    service.complete_asset(asset_id, tenant)
    return asset_id


def queued_job(service, key="request-1"):
    return service.create_job(ready_asset(service), "Describe the video", 512, key)["job"]["id"]


def fake_runner(service):
    class Runtime:
        calls = 0
        def analyze(self, *args):
            self.calls += 1
            return SimpleNamespace(text="Two people walking", output_tokens=4,
                                   gpu_execution_ms=40, peak_vram_bytes=1000)
    media = SimpleNamespace(duration_seconds=5.0, width=1920, height=1080, codec="h264")
    return Runner(service, Runtime(), lambda *args: media)


def test_end_to_end_api_upload_job_result(service):
    runner = fake_runner(service)
    with TestClient(create_app(service)) as client:
        headers = {"Authorization": f"Bearer {service.settings.api_key}"}
        assert client.get("/health").json()["model"] == MODEL_ID
        assert client.get("/openapi.json").status_code == 401
        assert client.get("/openapi.json", headers=headers).status_code == 200
        asset = client.post("/v1/assets", headers=headers, json={
            "filename": "sample.mp4", "content_type": "video/mp4", "size_bytes": 4,
        })
        assert asset.status_code == 201
        body = asset.json()
        assert body["upload"]["headers"]["x-goog-if-generation-match"] == "0"
        asset_id = body["asset"]["id"]
        record = service.asset(asset_id)
        service.objects.metadata[record["object_key"]] = {"size": 4, "generation": 17, "content_type": "video/mp4"}
        assert client.post(f"/v1/assets/{asset_id}/complete", headers=headers).status_code == 200
        response = client.post("/v1/jobs", headers={**headers, "Idempotency-Key": "example"},
                               json={"asset_id": asset_id, "prompt": "Describe the video"})
        assert response.status_code == 202
        job_id = response.json()["job"]["id"]
        assert client.get(f"/v1/jobs/{job_id}/result", headers=headers).status_code == 409
        assert runner.process(job_id)["status"] == "succeeded"
        assert client.get(f"/v1/jobs/{job_id}", headers=headers).json()["job"]["metrics"]["output_tokens"] == 4
        result = client.get(f"/v1/jobs/{job_id}/result", headers=headers)
        assert result.status_code == 200
        assert "generation=2" in result.json()["result_url"]
        assert service.store.get("tenants", "pilot")["active_jobs"] == 0


def test_ambiguous_enqueue_retry_reuses_job_and_reservation(service):
    asset_id = ready_asset(service)
    service.tasks.fail_after_accepting = True
    with pytest.raises(Problem, match="Submission is saved"):
        service.create_job(asset_id, "Describe", 512, "same-key")
    service.tasks.fail_after_accepting = False
    job = service.create_job(asset_id, "Describe", 512, "same-key")
    assert job["replayed"] is True
    assert len(service.tasks.ids) == 1
    assert service.asset(asset_id)["active_jobs"] == 1
    with pytest.raises(Problem) as conflict:
        service.create_job(asset_id, "Different", 512, "same-key")
    assert conflict.value.status == 409


def test_elanus_alias_preserves_checkpoint_and_idempotency(service):
    asset_id = ready_asset(service)
    client = TestClient(create_app(service))
    headers = {"Authorization": f"Bearer {service.settings.api_key}", "Idempotency-Key": "elanus"}
    body = {"asset_id": asset_id, "prompt": "Describe the video", "model": API_MODEL_ID}
    assert client.get("/health").json()["api_model_id"] == API_MODEL_ID
    response = client.post("/v1/jobs", headers=headers, json=body)
    assert response.status_code == 202
    job = response.json()["job"]
    assert (job["model"], job["model_id"], job["model_revision"]) == (API_MODEL_ID, MODEL_ID, MODEL_REVISION)
    del body["model"]
    replay = client.post("/v1/jobs", headers=headers, json=body).json()
    assert replay["replayed"] and replay["job"]["id"] == job["id"]
    assert fake_runner(service).process(job["id"])["status"] == "succeeded"
    result = service.objects.results[service.job(job["id"])["result_key"]]
    assert result["model"] == API_MODEL_ID and result["model_id"] == MODEL_ID


def test_unknown_public_model_and_mismatched_checkpoint_cannot_enqueue(service):
    asset_id = ready_asset(service)
    client = TestClient(create_app(service))
    headers = {"Authorization": f"Bearer {service.settings.api_key}", "Idempotency-Key": "wrong-model"}
    body = {"asset_id": asset_id, "prompt": "Describe", "model": "unknown-model"}
    assert client.post("/v1/jobs", headers=headers, json=body).status_code == 422
    service.settings = replace(service.settings, model_revision="different-revision")
    body["model"] = API_MODEL_ID
    assert client.post("/v1/jobs", headers=headers, json=body).status_code == 503
    assert not service.tasks.ids


def test_disabled_analysis_does_not_create_work(service):
    asset_id = ready_asset(service)
    service.settings = replace(service.settings, analysis_enabled=False)
    with TestClient(create_app(service)) as client:
        headers = {"Authorization": f"Bearer {service.settings.api_key}", "Idempotency-Key": "disabled"}
        assert client.get("/health").json()["analysis_enabled"] is False
        response = client.post("/v1/jobs", headers=headers,
                               json={"asset_id": asset_id, "prompt": "Describe the video"})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "analysis_unavailable"
    assert not service.tasks.ids
    assert service.asset(asset_id)["active_jobs"] == 0
    assert not any(collection == "jobs" for collection, _ in service.store.data)


def test_duplicate_delivery_does_not_run_model_twice(service):
    job_id = queued_job(service)
    runner = fake_runner(service)
    runner.process(job_id)
    assert runner.process(job_id)["replayed"] is True
    assert runner.runtime.calls == 1
    assert len([key for key in service.store.data if key[0] == "usage"]) == 1


def test_only_one_delivery_claims_job(service):
    job_id = queued_job(service)
    def attempt():
        try:
            return service.claim(job_id)
        except Problem:
            return None
    with ThreadPoolExecutor(max_workers=4) as executor:
        attempts = list(executor.map(lambda _: attempt(), range(4)))
    assert sum(item is not None for item in attempts) == 1


def test_result_recovers_after_database_write_failure(service):
    job_id = queued_job(service)
    runner = fake_runner(service)
    service.store.fail_finish = True
    with pytest.raises(RuntimeError):
        runner.process(job_id)
    service.store.fail_finish = False
    assert runner.process(job_id)["replayed"] is True
    assert service.job(job_id)["status"] == "succeeded"
    assert runner.runtime.calls == 1


def test_queued_cancel_never_invokes_model(service):
    job_id = queued_job(service)
    runner = fake_runner(service)
    assert service.cancel(job_id)["status"] == "cancelled"
    runner.process(job_id)
    assert runner.runtime.calls == 0
    assert service.store.get("tenants", "pilot")["active_jobs"] == 0


def test_running_cancel_preserves_usage_and_does_not_publish_result(service):
    job_id = queued_job(service)
    runner = fake_runner(service)
    original = runner.runtime.analyze
    def cancelling(*args):
        service.cancel(job_id)
        return original(*args)
    runner.runtime.analyze = cancelling
    assert runner.process(job_id)["status"] == "cancelled"
    assert service.store.get("usage", job_id)["metrics"]["gpu_execution_ms"] == 40
    assert not service.objects.results


def test_crashed_worker_times_out_without_automatic_gpu_retry(service):
    job_id = queued_job(service)
    service.claim(job_id)
    service.test_clock[0] += 1801
    assert service.claim(job_id) is None
    assert service.job(job_id)["status"] == "timed_out"
    assert service.store.get("usage", job_id)["measurement"] == "incomplete"


def test_interrupted_queued_cancellation_is_reconciled(service):
    job_id = queued_job(service)
    job = service.job(job_id)
    job["status"] = "cancel_requested"
    service.store.put("jobs", job_id, job)
    service.maintenance()
    assert service.job(job_id)["status"] == "cancelled"
    assert service.store.get("tenants", "pilot")["active_jobs"] == 0


def test_invalid_video_failure_is_metered(service):
    from services.inference.src.contracts import InputValidationError
    job_id = queued_job(service)
    runner = fake_runner(service)
    def reject(*args):
        raise InputValidationError("video duration exceeds limit")
    runner.probe = reject
    assert runner.process(job_id)["status"] == "failed"
    assert service.job(job_id)["error"]["code"] == "invalid_video"
    assert service.store.get("usage", job_id)["status"] == "failed"
    assert runner.runtime.calls == 0


def test_inference_failure_retains_known_video_duration(service):
    job_id = queued_job(service)
    runner = fake_runner(service)
    def reject(*args):
        raise RuntimeError("simulated GPU failure")
    runner.runtime.analyze = reject
    assert runner.process(job_id)["status"] == "failed"
    usage = service.store.get("usage", job_id)
    assert usage["metrics"]["video_seconds"] == 5.0
    assert "worker_ms" in usage["metrics"]
    assert "simulated" not in service.job(job_id)["error"]["message"]


def test_expiry_cleanup_protects_active_sources_and_deletes_expired_results(service):
    job_id = queued_job(service)
    job = service.job(job_id)
    source = service.asset(job["asset_id"])
    source["retention_until"] = service.clock() - 1
    service.store.put("assets", source["id"], source)
    service.maintenance()
    assert source["object_key"] not in service.objects.deleted
    fake_runner(service).process(job_id)
    service.maintenance()
    assert source["object_key"] in service.objects.deleted
    assert "retention_until" not in service.asset(source["id"])
    service.test_clock[0] += 31 * 86400
    service.maintenance()
    with pytest.raises(Problem) as expired:
        service.result(job_id)
    assert expired.value.status == 410
    assert job["result_key"] in service.objects.deleted
    assert "result_expires_at" not in service.job(job_id)


def test_tenant_boundary_quota_and_input_limits(service):
    other_asset = ready_asset(service, "other")
    with pytest.raises(Problem) as forbidden:
        service.create_job(other_asset, "Describe", 512, "unauthorized")
    assert forbidden.value.status == 404
    service.settings = replace(service.settings, max_active_jobs=1)
    queued_job(service)
    with pytest.raises(Problem) as exhausted:
        service.create_job(ready_asset(service), "Describe", 512, "second")
    assert exhausted.value.status == 429
    with TestClient(create_app(service)) as client:
        headers = {"Authorization": f"Bearer {service.settings.api_key}"}
        assert client.post("/v1/assets", headers=headers, json={"filename": "x", "content_type": "video/mp4", "size_bytes": True}).status_code == 422
        assert client.post("/v1/assets", headers=headers, content=b"x" * 40000).status_code == 413
        assert client.post("/internal/maintenance", headers=headers).status_code == 401
