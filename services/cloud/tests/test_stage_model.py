from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from services.cloud import stage_model
from services.cloud.stage_model import HubRetry, hub_session, stage_file


def test_hub_retry_honors_standard_and_hub_reset_headers():
    retry = HubRetry()
    assert retry.get_retry_after(SimpleNamespace(status=429, headers={"Retry-After": "35"})) == 35
    assert retry.get_retry_after(SimpleNamespace(status=429, headers={"RateLimit": '"resolvers";r=0;t=42'})) == 43
    assert retry.get_retry_after(SimpleNamespace(status=500, headers={"RateLimit": '"resolvers";r=0;t=42'})) is None


def test_hub_token_is_optional_and_not_forwarded_to_other_hosts(monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    with hub_session() as client:
        assert "Authorization" not in client.headers
    monkeypatch.setenv("HF_TOKEN", "hf_example_test_only")
    with hub_session() as client:
        assert client.headers["Authorization"] == "Bearer hf_example_test_only"
        assert client.should_strip_auth("https://huggingface.co/resolve/model", "https://cdn.example.test/model")


def test_completed_file_is_reused_without_network(monkeypatch):
    bucket = MagicMock()
    bucket.blob.return_value.exists.return_value = True
    http = MagicMock()
    monkeypatch.setattr(stage_model, "hub_session", http)
    stage_file(bucket, "pinned-revision", "model.safetensors")
    http.assert_not_called()
    bucket.blob.return_value.open.assert_not_called()


def test_interrupted_stream_exits_writer_with_error(monkeypatch):
    bucket = MagicMock()
    blob = bucket.blob.return_value
    blob.exists.return_value = False
    http = MagicMock()
    source = http.__enter__.return_value.get.return_value.__enter__.return_value
    source.iter_content.side_effect = RuntimeError("simulated interrupted download")
    monkeypatch.setattr(stage_model, "hub_session", lambda: http)
    with pytest.raises(RuntimeError, match="interrupted"):
        stage_file(bucket, "pinned-revision", "model.safetensors")
    assert blob.open.return_value.__exit__.call_args.args[0] is RuntimeError
    assert blob.open.call_args.kwargs["if_generation_match"] == 0
