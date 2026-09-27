"""Pause this pilot's task queue and GPU service, optionally after a short test window.

This local watchdog is a best-effort safeguard, not a billing cap. Keep the
computer awake; in-flight requests may finish after new requests are disabled.
"""
import argparse
import json
import signal
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

PROJECT = "video-api-dev-509820"
REGION = "us-central1"
SERVICE = "video-api-gpu"
QUEUE = "video-api-analysis"


def session():
    token = subprocess.run(["gcloud", "auth", "print-access-token", f"--project={PROJECT}"],
                           check=True, capture_output=True, text=True).stdout.strip()
    client = requests.Session()
    client.headers["Authorization"] = f"Bearer {token}"
    return client


def pause():
    resource = f"projects/{PROJECT}/locations/{REGION}"
    with session() as client:
        queue_error = None
        try:
            response = client.post(f"https://cloudtasks.googleapis.com/v2/{resource}/queues/{QUEUE}:pause",
                                   json={}, timeout=30)
            if response.status_code not in {200, 400, 409}:
                raise RuntimeError(f"Queue pause failed: HTTP {response.status_code}")
            queue = client.get(f"https://cloudtasks.googleapis.com/v2/{resource}/queues/{QUEUE}", timeout=30)
            queue.raise_for_status()
            if queue.json().get("state") != "PAUSED":
                raise RuntimeError("Queue is not paused")
        except Exception as error:
            # A queue failure must not prevent the independent GPU spending safeguard.
            queue_error = type(error).__name__
        url = f"https://run.googleapis.com/v2/{resource}/services/{SERVICE}"
        current = client.get(url, timeout=30)
        if current.status_code == 404:
            if queue_error:
                raise RuntimeError(f"GPU service absent, but queue pause unconfirmed: {queue_error}")
            print("Queue paused; GPU service does not exist", flush=True)
            return
        current.raise_for_status()
        response = client.patch(url, params={"updateMask": "scaling"}, json={
            "scaling": {"scalingMode": "MANUAL", "manualInstanceCount": 0},
        }, timeout=60)
        response.raise_for_status()
        operation = response.json()
        deadline = time.monotonic() + 240
        while not operation.get("done"):
            if time.monotonic() > deadline:
                raise RuntimeError("GPU pause operation did not finish within four minutes")
            time.sleep(5)
            response = client.get(f"https://run.googleapis.com/v2/{operation['name']}", timeout=30)
            response.raise_for_status()
            operation = response.json()
        if "error" in operation:
            raise RuntimeError(f"GPU pause operation failed: {operation['error'].get('code')}")
        response = client.get(url, timeout=30)
        response.raise_for_status()
        scaling = response.json().get("scaling", {})
        if scaling.get("scalingMode") != "MANUAL" or scaling.get("manualInstanceCount", 0) != 0:
            raise RuntimeError("GPU manual-zero scaling not confirmed")
        if queue_error:
            raise RuntimeError(f"GPU paused, but queue pause unconfirmed: {queue_error}")
        print(json.dumps({"project": PROJECT, "queue": "PAUSED", "gpu_scaling": scaling}), flush=True)


def disable_api():
    """Disable new job submissions without touching secrets or unrelated environment values."""
    subprocess.run([
        "gcloud", "run", "services", "update", "video-api-api", f"--project={PROJECT}",
        f"--region={REGION}", "--update-env-vars=ANALYSIS_ENABLED=false", "--quiet",
    ], capture_output=True, text=True, check=True, timeout=180)
    print("API analysis disabled", flush=True)


def wait_for_window(seconds, ready_file=None, startup_timeout=900):
    if ready_file:
        startup_deadline = time.monotonic() + startup_timeout
        print(f"Waiting up to {startup_timeout} seconds for confirmed testing readiness", flush=True)
        while not ready_file.is_file():
            if time.monotonic() >= startup_deadline:
                print("Startup deadline reached; pausing without opening a test window", flush=True)
                return
            time.sleep(min(1, startup_deadline - time.monotonic()))
        print(json.dumps({"test_window_started_at": datetime.now(timezone.utc).isoformat(),
                          "usable_seconds": seconds}), flush=True)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        time.sleep(min(10, deadline - time.monotonic()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--after-seconds", type=int, default=0)
    parser.add_argument("--ready-file", type=Path, help="Begin the countdown only after this local readiness marker exists")
    parser.add_argument("--startup-timeout", type=int, default=900, help="Pause if readiness is not confirmed in time")
    parser.add_argument("--disable-api", action="store_true", help="Also disable new analysis jobs on the CPU API")
    args = parser.parse_args()
    if not 0 <= args.after_seconds <= 3600:
        parser.error("The test window must be between zero and 3600 seconds")
    if not 1 <= args.startup_timeout <= 1800:
        parser.error("Startup timeout must be between one and 1800 seconds")
    if args.ready_file and args.ready_file.exists():
        parser.error("Use a fresh readiness marker path that does not already exist")
    if args.after_seconds:
        print(f"GPU safeguard armed for {args.after_seconds} seconds in {PROJECT}", flush=True)

    def interrupted(*args):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        wait_for_window(args.after_seconds, args.ready_file, args.startup_timeout)
    except KeyboardInterrupt:
        print("Stopping the test window early", flush=True)
    for attempt in range(3):
        pause_error = None
        try:
            pause()
        except Exception as error:
            pause_error = type(error).__name__
        try:
            if args.disable_api:
                disable_api()
            if pause_error:
                raise RuntimeError(pause_error)
            return
        except Exception as error:
            # Do not log OAuth credentials, full request exceptions or request headers.
            print(f"Pause attempt {attempt + 1} failed: {type(error).__name__}", flush=True)
            if attempt == 2:
                raise SystemExit("Automatic pause failed; manually disable video-api-gpu immediately") from None
            time.sleep(20)


if __name__ == "__main__":
    main()
