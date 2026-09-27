from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

# Public release identity must never replace the Hugging Face download ID.
ApiModel = Literal["elanus-1-8b"]
API_MODEL_ID: ApiModel = "elanus-1-8b"
MODEL_FAMILY = "Elanus"
MODEL_NAME = "Elanus 1 · 8B"
MODEL_ID = "allenai/Molmo2-8B"
MODEL_REVISION = "e28fa28597e5ec5e0cca2201dd8ab33d48bc4a1b"


@dataclass(frozen=True)
class Settings:
    project_id: str = ""
    product_name: str = "Video API"
    region: str = "us-central1"
    database: str = "video-api"
    bucket: str = ""
    queue: str = "video-api-analysis"
    worker_url: str = ""
    task_identity: str = ""
    signer_identity: str = ""
    api_key: str = ""
    allow_pilot_key: bool = False
    allowed_origin: str = "http://localhost:3000"
    model_id: str = MODEL_ID
    model_revision: str = MODEL_REVISION
    model_path: str = ""
    max_upload_bytes: int = 500 * 1024 * 1024
    max_video_seconds: int = 300
    source_retention_seconds: int = 86400
    result_retention_seconds: int = 30 * 86400
    queue_timeout_seconds: int = 7200
    execution_timeout_seconds: int = 1500
    lease_seconds: int = 1800
    max_active_jobs: int = 10
    analysis_enabled: bool = True

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            project_id=os.environ["GOOGLE_CLOUD_PROJECT"],
            product_name=os.getenv("PRODUCT_NAME", "Video API"),
            region=os.getenv("GOOGLE_CLOUD_REGION", "us-central1"),
            database=os.environ["FIRESTORE_DATABASE"],
            bucket=os.environ["MEDIA_BUCKET"],
            queue=os.environ["TASK_QUEUE"],
            worker_url=os.getenv("WORKER_URL", ""),
            task_identity=os.environ["TASK_SERVICE_ACCOUNT"],
            signer_identity=os.getenv("SIGNER_SERVICE_ACCOUNT", ""),
            api_key=os.getenv("API_KEY", ""),
            allow_pilot_key=os.getenv("ALLOW_PILOT_KEY", "false").lower() == "true",
            allowed_origin=os.getenv("ALLOWED_ORIGIN", "http://localhost:3000"),
            model_path=os.getenv("MODEL_PATH", ""),
            analysis_enabled=os.getenv("ANALYSIS_ENABLED", "true").lower() == "true",
        )
