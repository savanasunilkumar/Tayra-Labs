from __future__ import annotations

import json
import math
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from .contracts import InputValidationError


@dataclass(frozen=True)
class VideoInfo:
    duration_seconds: float
    width: int
    height: int
    codec: str
    container: str
    frames_per_second: float


def probe_video(
    path: Path,
    max_duration_seconds: float,
    max_pixels: int,
    max_dimension: int,
    max_frames_per_second: float,
) -> VideoInfo:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate",
        "-of",
        "json",
        str(path),
    ]
    try:
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        data = json.loads(completed.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError) as exc:
        raise InputValidationError("video could not be decoded") from exc

    if not isinstance(data, dict):
        raise InputValidationError("ffprobe returned invalid metadata")
    streams = data.get("streams")
    if not isinstance(streams, list):
        raise InputValidationError("video stream metadata is missing")
    video_stream = next(
        (item for item in streams if isinstance(item, dict) and item.get("codec_type") == "video"),
        None,
    )
    if video_stream is None:
        raise InputValidationError("file does not contain a video stream")

    format_data = data.get("format")
    if not isinstance(format_data, dict):
        raise InputValidationError("video container metadata is missing")
    try:
        duration = float(format_data["duration"])
        width = int(video_stream["width"])
        height = int(video_stream["height"])
    except (KeyError, TypeError, ValueError) as exc:
        raise InputValidationError("video duration or dimensions are invalid") from exc
    if not math.isfinite(duration) or duration <= 0 or duration > max_duration_seconds:
        raise InputValidationError(
            f"video duration must be greater than zero and no more than {max_duration_seconds:g} seconds"
        )
    if width <= 0 or height <= 0:
        raise InputValidationError("video dimensions are invalid")
    if width > max_dimension or height > max_dimension or width * height > max_pixels:
        raise InputValidationError("video resolution exceeds the configured limit")

    try:
        frames_per_second = float(Fraction(str(video_stream["avg_frame_rate"])))
    except (KeyError, ValueError, ZeroDivisionError) as exc:
        raise InputValidationError("video frame rate is invalid") from exc
    if (
        not math.isfinite(frames_per_second)
        or frames_per_second <= 0
        or frames_per_second > max_frames_per_second
    ):
        raise InputValidationError("video frame rate exceeds the configured limit")

    container = str(format_data.get("format_name", ""))
    allowed_container_tokens = {"mov", "mp4", "matroska", "webm"}
    if not allowed_container_tokens.intersection(container.split(",")):
        raise InputValidationError("video container must be MP4, MOV, or WebM")

    return VideoInfo(
        duration_seconds=duration,
        width=width,
        height=height,
        codec=str(video_stream.get("codec_name", "unknown")),
        container=container,
        frames_per_second=frames_per_second,
    )
