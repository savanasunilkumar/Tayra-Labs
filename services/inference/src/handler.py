from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

import requests
import runpod

from .contracts import JobInput, validate_job
from .media import probe_video
from .model import MolmoRuntime


MODEL_ID = os.getenv("MODEL_ID", "allenai/Molmo2-4B")
MODEL_REVISION = os.getenv(
    "MODEL_REVISION", "042abfa7a38879a376cec03d949eff0aefaa0600"
)
ALLOWED_R2_HOST_SUFFIX = os.getenv(
    "ALLOWED_R2_HOST_SUFFIX", ".r2.cloudflarestorage.com"
)
HARD_MAX_DOWNLOAD_BYTES = int(os.getenv("MAX_DOWNLOAD_BYTES", str(500 * 1024 * 1024)))
MAX_VIDEO_SECONDS = float(os.getenv("MAX_VIDEO_SECONDS", "300"))
MAX_VIDEO_PIXELS = int(os.getenv("MAX_VIDEO_PIXELS", str(3840 * 2160)))
MAX_VIDEO_DIMENSION = int(os.getenv("MAX_VIDEO_DIMENSION", "4096"))
MAX_VIDEO_FPS = float(os.getenv("MAX_VIDEO_FPS", "120"))

RUNTIME = MolmoRuntime(MODEL_ID, MODEL_REVISION)


def _download_video(job: JobInput, destination: Path) -> int:
    with requests.get(
        job.video_url,
        stream=True,
        timeout=(10, 600),
        allow_redirects=False,
    ) as response:
        response.raise_for_status()
        declared_length = response.headers.get("content-length")
        if declared_length is not None and int(declared_length) > job.max_download_bytes:
            raise ValueError("source video exceeds the download limit")

        downloaded = 0
        with destination.open("wb") as output:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                downloaded += len(chunk)
                if downloaded > job.max_download_bytes:
                    raise ValueError("source video exceeds the download limit")
                output.write(chunk)
    if downloaded != job.expected_bytes:
        raise ValueError("downloaded video size does not match the verified asset size")
    return downloaded


def _upload_result(url: str, result: dict[str, object]) -> int:
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    response = requests.put(
        url,
        data=encoded,
        headers={"content-type": "application/json"},
        timeout=(10, 120),
        allow_redirects=False,
    )
    response.raise_for_status()
    return len(encoded)


def handler(event: object) -> dict[str, object]:
    job = validate_job(
        event,
        allowed_host_suffix=ALLOWED_R2_HOST_SUFFIX,
        hard_max_download_bytes=HARD_MAX_DOWNLOAD_BYTES,
    )
    if job.model_id != MODEL_ID:
        raise ValueError("requested model does not match the loaded model")
    if job.model_revision != MODEL_REVISION:
        raise ValueError("requested model revision does not match the loaded model")

    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix=f"inqox-{job.job_id}-") as temporary_directory:
        video_path = Path(temporary_directory) / "source-video"
        downloaded_bytes = _download_video(job, video_path)
        video = probe_video(
            video_path,
            MAX_VIDEO_SECONDS,
            MAX_VIDEO_PIXELS,
            MAX_VIDEO_DIMENSION,
            MAX_VIDEO_FPS,
        )
        model_output = RUNTIME.analyze(video_path, job.prompt, job.max_new_tokens)
        wall_time_ms = round((time.perf_counter() - started) * 1_000)

        result: dict[str, object] = {
            "version": "2026-09-20",
            "job_id": job.job_id,
            "model": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "mode": job.mode,
            "output": {"text": model_output.text},
            "media": {
                "duration_seconds": round(video.duration_seconds, 3),
                "width": video.width,
                "height": video.height,
                "codec": video.codec,
                "container": video.container,
                "frames_per_second": round(video.frames_per_second, 3),
                "downloaded_bytes": downloaded_bytes,
            },
            "metrics": {
                "gpu_execution_ms": model_output.gpu_execution_ms,
                "wall_time_ms": wall_time_ms,
                "output_tokens": model_output.output_tokens,
            },
        }
        result_bytes = _upload_result(job.result_put_url, result)

    return {
        "job_id": job.job_id,
        "result_written": True,
        "result_bytes": result_bytes,
        "output_tokens": model_output.output_tokens,
        "metrics": {
            "gpu_execution_ms": model_output.gpu_execution_ms,
            "wall_time_ms": wall_time_ms,
            "video_seconds": round(video.duration_seconds, 3),
        },
    }


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
