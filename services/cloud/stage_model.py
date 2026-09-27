"""Stream the pinned public checkpoint to GCS without buffering multi-GB shards on disk."""
from __future__ import annotations

import argparse
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import PurePosixPath

import requests
from google.cloud import storage
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .config import MODEL_ID, MODEL_REVISION


class HubRetry(Retry):
    def get_retry_after(self, response):
        delay = super().get_retry_after(response)
        if delay is None and response.status == 429:
            reset = re.search(r"(?:^|;)\s*t=(\d+)", response.headers.get("RateLimit", ""))
            if reset:
                delay = int(reset.group(1)) + 1
        return delay


def hub_session():
    session = requests.Session()
    token = os.getenv("HF_TOKEN", "").strip()
    if token:
        session.headers["Authorization"] = f"Bearer {token}"
    # Requests removes Authorization on redirects to other hosts (e.g. a signed download CDN).
    session.mount("https://", HTTPAdapter(max_retries=HubRetry(
        total=5, connect=3, read=0, status=5, backoff_factor=10,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=frozenset(["GET"]), respect_retry_after_header=True,
    )))
    return session


def stage_file(bucket, prefix, name):
    blob = bucket.blob(f"{prefix}/{name}")
    if blob.exists():
        print(f"Reusing {name}", flush=True)
        return
    print(f"Staging {name}", flush=True)
    with hub_session() as session:
        with session.get(f"https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}/{name}",
                         stream=True, timeout=(30, 300)) as source:
            source.raise_for_status()
            # BlobWriter aborts, rather than commits a partial object, if this context raises.
            with blob.open("wb", chunk_size=8 * 1024 * 1024, if_generation_match=0,
                           ignore_flush=True, timeout=300) as target:
                for chunk in source.iter_content(8 * 1024 * 1024):
                    target.write(chunk)
    print(f"Staged {name}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--bucket", required=True)
    args = parser.parse_args()
    session = hub_session()
    bucket = storage.Client(project=args.project).bucket(args.bucket)
    prefix = f"molmo2-8b/{MODEL_REVISION}"
    marker = bucket.blob(f"{prefix}/.complete.json")
    if marker.exists():
        print("Pinned model snapshot is already staged")
        return
    response = session.get(f"https://huggingface.co/api/models/{MODEL_ID}/revision/{MODEL_REVISION}", timeout=60)
    response.raise_for_status()
    metadata = response.json()
    if metadata["sha"] != MODEL_REVISION:
        raise RuntimeError("Unexpected model revision")
    names = [item["rfilename"] for item in metadata["siblings"]
             if PurePosixPath(item["rfilename"]).suffix in {".json", ".py", ".jinja", ".txt", ".safetensors"}]
    if not any(name.endswith(".safetensors") for name in names):
        raise RuntimeError("Checkpoint contains no model weights")
    for name in names:
        if PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts:
            raise RuntimeError("Unsafe checkpoint path")
    # Four bounded transfers improve throughput without an unbounded download fan-out.
    # Every file has its own retry-aware HTTP session; checkpoint publication waits for all of them.
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda name: stage_file(bucket, prefix, name), names))
    marker.upload_from_string(json.dumps({"model_id": MODEL_ID, "revision": MODEL_REVISION, "files": names}),
                              content_type="application/json", if_generation_match=0)
    print("Pinned model snapshot is complete")


if __name__ == "__main__":
    main()
