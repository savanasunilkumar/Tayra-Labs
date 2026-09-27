from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.contracts import InputValidationError  # noqa: E402
from src.media import probe_video  # noqa: E402


def ffprobe_result(*, width: int = 1920, height: int = 1080, fps: str = "30/1"):
    payload = {
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": width,
                "height": height,
                "avg_frame_rate": fps,
            }
        ],
        "format": {"duration": "10.0", "format_name": "mov,mp4"},
    }
    return type("Completed", (), {"stdout": json.dumps(payload)})()


class MediaValidationTests(unittest.TestCase):
    @patch("src.media.subprocess.run")
    def test_accepts_bounded_video(self, run) -> None:
        run.return_value = ffprobe_result()
        video = probe_video(Path("video.mp4"), 300, 3840 * 2160, 4096, 120)
        self.assertEqual(video.width, 1920)
        self.assertEqual(video.frames_per_second, 30)

    @patch("src.media.subprocess.run")
    def test_rejects_extreme_resolution(self, run) -> None:
        run.return_value = ffprobe_result(width=7680, height=4320)
        with self.assertRaises(InputValidationError):
            probe_video(Path("video.mp4"), 300, 3840 * 2160, 4096, 120)

    @patch("src.media.subprocess.run")
    def test_rejects_extreme_frame_rate(self, run) -> None:
        run.return_value = ffprobe_result(fps="240/1")
        with self.assertRaises(InputValidationError):
            probe_video(Path("video.mp4"), 300, 3840 * 2160, 4096, 120)


if __name__ == "__main__":
    unittest.main()
