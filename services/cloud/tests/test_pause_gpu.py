from unittest.mock import MagicMock, patch

import pytest

from scripts import pause_gpu


def response(body, status=200):
    value = MagicMock()
    value.status_code = status
    value.json.return_value = body
    return value


def test_pause_confirms_queue_then_manual_zero():
    client = MagicMock()
    client.__enter__.return_value = client
    client.post.return_value = response({})
    client.get.side_effect = [
        response({"state": "PAUSED"}),
        response({"name": "worker"}),
        response({"scaling": {"scalingMode": "MANUAL", "manualInstanceCount": 0}}),
    ]
    client.patch.return_value = response({"done": True})
    with patch.object(pause_gpu, "session", return_value=client):
        pause_gpu.pause()
    args = client.patch.call_args
    assert "video-api-dev-509820" in args.args[0]
    assert args.kwargs["params"] == {"updateMask": "scaling"}
    assert args.kwargs["json"] == {"scaling": {"scalingMode": "MANUAL", "manualInstanceCount": 0}}


def test_queue_failure_does_not_prevent_gpu_pause():
    client = MagicMock()
    client.__enter__.return_value = client
    client.post.return_value = response({})
    client.get.side_effect = [
        response({"state": "RUNNING"}),
        response({"name": "worker"}),
        response({"scaling": {"scalingMode": "MANUAL", "manualInstanceCount": 0}}),
    ]
    client.patch.return_value = response({"done": True})
    with patch.object(pause_gpu, "session", return_value=client), pytest.raises(RuntimeError, match="GPU paused"):
        pause_gpu.pause()
    client.patch.assert_called_once()


def test_pause_without_deployed_gpu_still_pauses_queue():
    client = MagicMock()
    client.__enter__.return_value = client
    client.post.return_value = response({})
    client.get.side_effect = [response({"state": "PAUSED"}), response({}, status=404)]
    with patch.object(pause_gpu, "session", return_value=client):
        pause_gpu.pause()
    client.patch.assert_not_called()


def test_pause_rejects_failed_operation():
    client = MagicMock()
    client.__enter__.return_value = client
    client.post.return_value = response({})
    client.get.side_effect = [response({"state": "PAUSED"}), response({"name": "worker"})]
    client.patch.return_value = response({"done": True, "error": {"code": 7}})
    with patch.object(pause_gpu, "session", return_value=client), pytest.raises(RuntimeError, match="operation failed"):
        pause_gpu.pause()


def test_ready_marker_starts_full_window_only_after_readiness():
    marker = MagicMock()
    marker.is_file.side_effect = [False, False, True]
    now = [0.0]
    with patch.object(pause_gpu.time, "monotonic", side_effect=lambda: now[0]), \
            patch.object(pause_gpu.time, "sleep", side_effect=lambda seconds: now.__setitem__(0, now[0] + seconds)):
        pause_gpu.wait_for_window(600, marker, 900)
    assert now[0] == 602


def test_missing_marker_cannot_leave_gpu_running_indefinitely():
    marker = MagicMock()
    marker.is_file.return_value = False
    now = [0.0]
    with patch.object(pause_gpu.time, "monotonic", side_effect=lambda: now[0]), \
            patch.object(pause_gpu.time, "sleep", side_effect=lambda seconds: now.__setitem__(0, now[0] + seconds)):
        pause_gpu.wait_for_window(600, marker, 15)
    assert now[0] == 15


def test_disable_api_is_scoped_and_does_not_expose_credentials():
    with patch.object(pause_gpu.subprocess, "run") as run:
        pause_gpu.disable_api()
    args = run.call_args.args[0]
    assert "--project=video-api-dev-509820" in args
    assert "--region=us-central1" in args
    assert "--update-env-vars=ANALYSIS_ENABLED=false" in args
    assert run.call_args.kwargs["capture_output"] is True
