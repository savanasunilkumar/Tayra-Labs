from __future__ import annotations

import tempfile
import time
from pathlib import Path
from threading import Lock
from typing import Callable

from services.inference.src.media import probe_video
from services.inference.src.contracts import InputValidationError

from .ports import Document
from .service import Problem, Service


class Runner:
    def __init__(self, service: Service, runtime, probe: Callable = probe_video):
        self.service, self.runtime, self.probe = service, runtime, probe
        self.lock = Lock()

    def process(self, job_id: str) -> Document:
        # Cloud Run concurrency=1 is also enforced locally so two model calls never share GPU memory.
        if not self.lock.acquire(blocking=False):
            raise Problem(503, "worker_busy", "Worker is busy")
        try:
            job = self.service.claim(job_id)
            if job is None:
                return {"accepted": True, "replayed": True}
            settings = self.service.settings
            started = time.monotonic()
            metrics: Document = {}
            try:
                if (job["model_id"], job["model_revision"]) != (settings.model_id, settings.model_revision):
                    raise InputValidationError("Requested model does not match the deployed model")
                if not 0 < job["source_size"] <= settings.max_upload_bytes:
                    raise InputValidationError("Source size exceeds the configured limit")
                with tempfile.TemporaryDirectory(prefix="video-api-") as directory:
                    path = Path(directory) / "source-video"
                    self.service.objects.download(job["source_key"], job["source_generation"], path, job["source_size"])
                    media = self.probe(path, settings.max_video_seconds, 8294400, 4096, 120)
                    metrics["video_seconds"] = media.duration_seconds
                    if self.service.store.get("jobs", job_id)["status"] == "cancel_requested":
                        metrics["worker_ms"] = round((time.monotonic() - started) * 1000)
                        self.service.finish(job_id, "cancelled", metrics)
                        return {"accepted": True, "status": "cancelled"}
                    output = self.runtime.analyze(path, job["prompt"], job["max_new_tokens"])
                    metrics = dict(gpu_execution_ms=output.gpu_execution_ms, output_tokens=output.output_tokens,
                                   peak_vram_bytes=output.peak_vram_bytes, video_seconds=media.duration_seconds,
                                   worker_ms=round((time.monotonic() - started) * 1000))
                    result = dict(job_id=job_id, model_id=settings.model_id, model_revision=settings.model_revision,
                                  mode=job["mode"], output={"text": output.text}, metrics=metrics,
                                  media={"duration_seconds": media.duration_seconds, "width": media.width,
                                         "height": media.height, "codec": media.codec})
                    if job.get("model"):
                        result["model"] = job["model"]
                    if self.service.store.get("jobs", job_id)["status"] == "cancel_requested":
                        self.service.finish(job_id, "cancelled", metrics)
                        return {"accepted": True, "status": "cancelled"}
                    self.service.objects.write_result(job["result_key"], result)
            except Exception as error:
                metrics["worker_ms"] = round((time.monotonic() - started) * 1000)
                code = "invalid_video" if isinstance(error, InputValidationError) else "inference_failed"
                message = str(error) if isinstance(error, InputValidationError) else "The worker could not complete analysis"
                self.service.finish(job_id, "failed", metrics, {"code": code, "message": message})
                return {"accepted": True, "status": "failed"}
            # If this write fails, Cloud Tasks redelivers and reconciliation recovers the immutable result.
            self.service.finish(job_id, "succeeded", metrics)
            return {"accepted": True, "status": "succeeded"}
        finally:
            self.lock.release()
