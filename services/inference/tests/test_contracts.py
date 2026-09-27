from __future__ import annotations

import sys
import unittest
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.contracts import InputValidationError, validate_job  # noqa: E402


def signed_url(object_name: str) -> str:
    return (
        f"https://account.r2.cloudflarestorage.com/inqox-media/{object_name}"
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256"
        "&X-Amz-Credential=test"
        "&X-Amz-Date=20260920T000000Z"
        "&X-Amz-Expires=3600"
        "&X-Amz-Signature=test-signature"
    )


def valid_event() -> dict[str, object]:
    return {
        "input": {
            "job_id": str(uuid4()),
            "video_url": signed_url("source.mp4"),
            "result_put_url": signed_url("result.json"),
            "prompt": "Summarize the video.",
            "mode": "standard",
            "model_id": "allenai/Molmo2-4B",
            "model_revision": "042abfa7a38879a376cec03d949eff0aefaa0600",
            "max_new_tokens": 512,
            "max_download_bytes": 1_000_000,
            "expected_bytes": 500_000,
        }
    }


class ContractTests(unittest.TestCase):
    def test_valid_job(self) -> None:
        parsed = validate_job(
            valid_event(),
            allowed_host_suffix=".r2.cloudflarestorage.com",
            hard_max_download_bytes=2_000_000,
        )
        self.assertEqual(parsed.mode, "standard")
        self.assertEqual(parsed.expected_bytes, 500_000)

    def test_rejects_non_r2_url(self) -> None:
        event = valid_event()
        payload = event["input"]
        assert isinstance(payload, dict)
        payload["video_url"] = "https://example.com/video.mp4"
        with self.assertRaises(InputValidationError):
            validate_job(
                event,
                allowed_host_suffix=".r2.cloudflarestorage.com",
                hard_max_download_bytes=2_000_000,
            )

    def test_rejects_disabled_mode(self) -> None:
        event = valid_event()
        payload = event["input"]
        assert isinstance(payload, dict)
        payload["mode"] = "dense"
        with self.assertRaises(InputValidationError):
            validate_job(
                event,
                allowed_host_suffix=".r2.cloudflarestorage.com",
                hard_max_download_bytes=2_000_000,
            )

    def test_rejects_oversized_job_limit(self) -> None:
        event = valid_event()
        payload = event["input"]
        assert isinstance(payload, dict)
        payload["max_download_bytes"] = 3_000_000
        with self.assertRaises(InputValidationError):
            validate_job(
                event,
                allowed_host_suffix=".r2.cloudflarestorage.com",
                hard_max_download_bytes=2_000_000,
            )


if __name__ == "__main__":
    unittest.main()
