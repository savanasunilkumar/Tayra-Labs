"""Local account-aware API. Uses the dedicated project's ADC, never pilot credentials.

Run from the repository root with .venv/bin/python scripts/account_api.py.
Inference is always disabled by this local launcher.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if __name__ == "__main__":
    if os.getenv("FIREBASE_AUTH_EMULATOR_HOST"):
        raise SystemExit("Do not connect the real project to an authentication emulator")
    project = "video-api-dev-509820"
    os.environ.update({
        "GOOGLE_CLOUD_PROJECT": project,
        "GOOGLE_CLOUD_QUOTA_PROJECT": project,
        "GOOGLE_CLOUD_REGION": "us-central1",
        "PRODUCT_NAME": "Tayra Labs",
        "FIRESTORE_DATABASE": "video-api",
        "MEDIA_BUCKET": f"{project}-video-api-media",
        "TASK_QUEUE": "video-api-analysis",
        "TASK_SERVICE_ACCOUNT": f"video-api-tasks@{project}.iam.gserviceaccount.com",
        "SIGNER_SERVICE_ACCOUNT": f"video-api-api@{project}.iam.gserviceaccount.com",
        "WORKER_URL": "https://video-api-gpu-7pgxmg73ya-uc.a.run.app",
        "ALLOWED_ORIGIN": "http://127.0.0.1:3100",
        "ANALYSIS_ENABLED": "false",
        "ALLOW_PILOT_KEY": "false",
    })
    import uvicorn
    uvicorn.run("services.cloud.api:app", host="127.0.0.1", port=8080, access_log=False)
