"""Run one paid GPU analysis after deployment; never prints API keys or signed URLs."""
import argparse
import json
import os
import subprocess
import time
from pathlib import Path
from uuid import uuid4

import requests


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--prompt", default="Describe the main events in this video.")
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--google-auth", action="store_true",
                        help="Also authenticate to the private Cloud Run API using the signed-in gcloud identity")
    parser.add_argument("--instance-hourly-usd", type=float,
                        help="Combined GPU + CPU + RAM hourly rate, before credits")
    args = parser.parse_args()
    api_url = os.environ["VIDEO_API_URL"].rstrip("/")
    key = os.environ["VIDEO_API_KEY"]
    if not api_url.startswith("https://"):
        parser.error("VIDEO_API_URL must use HTTPS")
    types = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}
    content_type = types.get(args.video.suffix.lower())
    if not args.video.is_file() or content_type is None:
        parser.error("Provide an existing MP4, MOV, or WebM file")
    if not 0 < args.video.stat().st_size <= 500 * 1024 * 1024:
        parser.error("Video must be between 1 byte and 500 MiB")
    if not 1 <= args.max_new_tokens <= 2048:
        parser.error("--max-new-tokens must be between 1 and 2048")
    if args.instance_hourly_usd is not None and args.instance_hourly_usd <= 0:
        parser.error("Hourly rate must be positive")

    identity_token, identity_expiry = "", 0.0

    def api(method, path, **kwargs):
        nonlocal identity_token, identity_expiry
        headers = {"Authorization": f"Bearer {key}", **kwargs.pop("headers", {})}
        if args.google_auth:
            if time.monotonic() >= identity_expiry:
                identity_token = subprocess.run(["gcloud", "auth", "print-identity-token"],
                                                check=True, capture_output=True, text=True).stdout.strip()
                identity_expiry = time.monotonic() + 2700
            headers["X-Serverless-Authorization"] = f"Bearer {identity_token}"
        response = requests.request(method, api_url + path, timeout=60,
                                    headers=headers, **kwargs)
        response.raise_for_status()
        return response.json()

    started = time.monotonic()
    asset = api("POST", "/v1/assets", json={"filename": args.video.name, "content_type": content_type,
                                          "size_bytes": args.video.stat().st_size})
    with args.video.open("rb") as video:
        response = requests.put(asset["upload"]["url"], headers=asset["upload"]["headers"], data=video, timeout=600)
        response.raise_for_status()
    asset_id = asset["asset"]["id"]
    api("POST", f"/v1/assets/{asset_id}/complete")
    idempotency_key = str(uuid4())
    print(f"asset_id={asset_id}; Idempotency-Key={idempotency_key}", flush=True)
    for attempt in range(3):
        try:
            job = api("POST", "/v1/jobs", headers={"Idempotency-Key": idempotency_key}, json={
                "asset_id": asset_id, "prompt": args.prompt, "max_new_tokens": args.max_new_tokens,
            })["job"]
            break
        except (requests.Timeout, requests.ConnectionError, requests.HTTPError) as error:
            status = error.response.status_code if error.response is not None else 503
            if status < 500 or attempt == 2:
                raise
            time.sleep(3)
    print(f"job_id={job['id']}", flush=True)
    # Covers the two-hour queue deadline plus the worker lease, without resubmitting inference.
    deadline = time.monotonic() + 9300
    previous = None
    while job["status"] not in {"succeeded", "failed", "cancelled", "timed_out"}:
        if time.monotonic() >= deadline:
            raise RuntimeError("Polling deadline exceeded; inspect the existing job before retrying")
        if job["status"] != previous:
            print(f"status={job['status']}", flush=True)
            previous = job["status"]
        time.sleep(5)
        job = api("GET", f"/v1/jobs/{job['id']}")["job"]
    if job["status"] != "succeeded":
        print(json.dumps(job, indent=2))
        raise SystemExit(1)
    result = api("GET", f"/v1/jobs/{job['id']}/result")
    response = requests.get(result["result_url"], timeout=60)
    response.raise_for_status()
    output = response.json()
    output["client_wall_seconds"] = round(time.monotonic() - started, 2)
    if args.instance_hourly_usd is not None:
        metrics = output["metrics"]
        # Ratio of worker seconds to video seconds scales the instance rate to one processed video-hour.
        lower_bound = args.instance_hourly_usd * metrics["worker_ms"] / 1000 / metrics["video_seconds"]
        output["cost_check"] = {
            "worker_only_usd_per_video_hour": round(lower_bound, 4),
            "proposed_customer_usd_per_video_hour": 1.49,
            "fully_loaded_cogs_ceiling_for_45_percent_margin": 0.8195,
            "warning": "Not fully loaded COGS: excludes startup, idle time, other services, fees and failed work. "
                       "Compare with actual billing before setting prices. Credits do not reduce economic cost.",
        }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as error:
        # Request exceptions can contain sensitive signed URLs, so only show the type/status.
        status = error.response.status_code if error.response is not None else "unavailable"
        raise SystemExit(f"Request failed ({type(error).__name__}, HTTP {status}). Inspect the existing job before retrying.") from None
