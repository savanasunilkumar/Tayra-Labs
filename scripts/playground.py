"""Loopback-only testing UI for the existing private Google Cloud pilot.

No GPU lifecycle controls, public deployment, or browser-visible cloud credentials.
Run with: .venv/bin/python scripts/playground.py
"""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import secrets
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from fastapi import FastAPI, Header, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "apps" / "playground"
PROJECT = "video-api-dev-509820"
API_URL = "https://video-api-api-7pgxmg73ya-uc.a.run.app"
BUCKET = "video-api-dev-509820-video-api-media"
MODEL = "allenai/Molmo2-8B"
API_MODEL_ID = "elanus-1-8b"
SAVED_JOB = "8f0ddf81-43eb-4cbb-8fcd-a6cbd0c19d5f"
SAMPLE = Path("/private/tmp/video-api-smoke.kafMnd/penguins-10s.mp4")
MAX_BYTES = 500 * 1024 * 1024
VIDEO_TYPES = {"video/mp4", "video/webm", "video/quicktime"}


class LocalError(Exception):
    def __init__(self, status: int, message: str):
        self.status, self.message = status, message


class AssetInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=100)
    size_bytes: StrictInt = Field(gt=0, le=MAX_BYTES)


class JobInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    model: Literal["elanus-1-8b"] = API_MODEL_ID
    asset_id: UUID
    prompt: str = Field(min_length=1, max_length=4000)
    max_new_tokens: StrictInt = Field(default=256, ge=1, le=2048)


def validate_storage_url(url: str) -> str:
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname != "storage.googleapis.com"
            or parsed.port not in (None, 443) or parsed.username or parsed.password
            or not parsed.path.startswith(f"/{BUCKET}/")):
        raise LocalError(502, "The API returned an unexpected storage location.")
    return url


class CloudClient:
    def __init__(self):
        self.identity = ""
        self.key = ""
        self.expires = 0.0
        self.lock = asyncio.Lock()

    @staticmethod
    def _credentials() -> tuple[str, str]:
        def read(args):
            try:
                value = subprocess.run(["gcloud", *args, f"--project={PROJECT}"],
                                       capture_output=True, text=True, check=True, timeout=40).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                raise LocalError(503, "Google login needs attention. Run gcloud auth login in your terminal, "
                                 "then reconnect. Never paste credentials into this page.") from None
            if not value:
                raise LocalError(503, "Google credentials are unavailable. Check your local gcloud login.")
            return value
        return (read(["auth", "print-identity-token"]),
                read(["secrets", "versions", "access", "latest", "--secret=video-api-api-key"]))

    async def headers(self):
        async with self.lock:
            if time.monotonic() >= self.expires:
                self.identity, self.key = await asyncio.to_thread(self._credentials)
                self.expires = time.monotonic() + 2700
        return {"Authorization": f"Bearer {self.key}",
                "X-Serverless-Authorization": f"Bearer {self.identity}"}

    async def api(self, method, path, *, body=None, idempotency_key=None):
        headers = await self.headers()
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        try:
            async with httpx.AsyncClient(timeout=65, follow_redirects=False, trust_env=False) as client:
                response = await client.request(method, API_URL + path, headers=headers, json=body)
        except httpx.HTTPError:
            raise LocalError(502, "The private API could not be reached. For a submitted analysis, retry "
                             "the same request rather than starting another job.") from None
        if response.status_code >= 400:
            if response.status_code in (401, 403):
                self.expires = 0
            messages = {
                401: "The API rejected authentication. Reconnect with your authorized Google account.",
                403: "Your Google account does not have access to this private API.",
                404: "This item is unavailable or its result has expired.",
                409: "This request conflicts with the current asset or job state.",
                429: "The pilot has reached its active-job limit. Wait for an existing job to finish.",
                503: "Analysis is paused or the queue is unavailable. No GPU is resumed by this interface.",
            }
            raise LocalError(response.status_code, messages.get(response.status_code,
                             f"The API rejected this request (HTTP {response.status_code})."))
        if response.status_code == 204:
            return {}
        try:
            return response.json()
        except ValueError:
            raise LocalError(502, "The private API returned an unreadable response.") from None

    async def upload(self, url, headers, content):
        try:
            async with httpx.AsyncClient(timeout=600, follow_redirects=False, trust_env=False) as client:
                response = await client.put(validate_storage_url(url), headers=headers, content=content)
            if response.status_code == 412:
                # Immutable PUT may already have completed before a connection was lost.
                return
            if not response.is_success:
                raise LocalError(502, "Video upload failed. The source is never overwritten.")
        except httpx.HTTPError:
            raise LocalError(502, "Video upload was interrupted. Select the file again to retry.") from None

    async def result(self, job_id):
        signed = await self.api("GET", f"/v1/jobs/{job_id}/result")
        try:
            async with httpx.AsyncClient(timeout=65, follow_redirects=False, trust_env=False) as client:
                async with client.stream("GET", validate_storage_url(signed["result_url"])) as response:
                    if not response.is_success:
                        raise LocalError(502, "The saved result could not be downloaded.")
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > 1024 * 1024:
                            raise LocalError(502, "The saved result exceeds the supported size.")
            return json.loads(data)
        except (httpx.HTTPError, ValueError):
            raise LocalError(502, "The saved result could not be read. Try loading it again.") from None


@dataclass
class Upload:
    url: str
    content_type: str
    size: int
    expires: float


def create_app(cloud=None, *, port=3000, sample=SAMPLE):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    cloud = cloud or CloudClient()
    session_token = secrets.token_urlsafe(32)
    origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    uploads: dict[str, Upload] = {}

    @app.exception_handler(LocalError)
    async def known_error(request, error):
        return JSONResponse({"error": error.message}, status_code=error.status)

    @app.exception_handler(Exception)
    async def unknown_error(request, error):
        # Never return exceptions containing tokens, signed URLs, or video contents.
        return JSONResponse({"error": "The local bridge encountered an error. Reconnect and try again."},
                            status_code=500)

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        if (request.headers.get("host") not in hosts
                or request.headers.get("sec-fetch-site") == "cross-site"
                or (request.headers.get("origin") and request.headers["origin"] not in origins)):
            return JSONResponse({"error": "Only the local playground can access this bridge."}, status_code=403)
        if request.url.path.startswith("/api/") and request.url.path != "/api/session":
            if not hmac.compare_digest(request.headers.get("x-playground-token", ""), session_token):
                return JSONResponse({"error": "Reload the playground to establish a local session."}, status_code=403)
        if request.method == "POST":
            # Bound JSON before Pydantic parses it. Video bytes use the streaming PUT route.
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 32768:
                    return JSONResponse({"error": "Request is too large."}, status_code=413)
            request._body = bytes(body)
        response = await call_next(request)
        response.headers.update({
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; "
                "img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; "
                "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        })
        return response

    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/app.js")
    async def javascript():
        return FileResponse(STATIC / "app.js", media_type="text/javascript")

    @app.get("/styles.css")
    async def stylesheet():
        return FileResponse(STATIC / "styles.css", media_type="text/css")

    @app.get("/tayra-logo.svg")
    async def logo():
        return FileResponse(STATIC / "tayra-logo.svg", media_type="image/svg+xml")

    @app.get("/api/session")
    async def session():
        return {"token": session_token, "project": PROJECT, "model": API_MODEL_ID, "checkpoint": MODEL,
                "sample_available": sample.is_file(), "saved_job": SAVED_JOB}

    @app.get("/api/health")
    async def health():
        return await cloud.api("GET", "/health")

    @app.get("/sample/video")
    async def sample_video():
        if not sample.is_file():
            raise LocalError(404, "The local sample is unavailable. Choose your own video.")
        return FileResponse(sample, media_type="video/mp4", filename="penguins-10s.mp4",
                            content_disposition_type="inline")

    @app.post("/api/assets", status_code=201)
    async def create_asset(body: AssetInput):
        if body.content_type not in VIDEO_TYPES:
            raise LocalError(400, "Choose an MP4, MOV, or WebM video.")
        if not (await cloud.api("GET", "/health")).get("analysis_enabled"):
            raise LocalError(503, "Analysis is paused. Your video has not been uploaded.")
        for key in list(uploads):
            if uploads[key].expires <= time.monotonic():
                uploads.pop(key)
        if len(uploads) >= 20:
            raise LocalError(429, "Too many pending uploads. Wait for an upload to finish or expire.")
        value = await cloud.api("POST", "/v1/assets", body=body.model_dump())
        asset_id = str(UUID(value["asset"]["id"]))
        uploads[asset_id] = Upload(validate_storage_url(value["upload"]["url"]), body.content_type,
                                   body.size_bytes, time.monotonic() + 840)
        return {"asset": value["asset"]}

    @app.put("/api/assets/{asset_id}/content")
    async def upload_content(asset_id: UUID, request: Request):
        key = str(asset_id)
        pending = uploads.get(key)
        if pending is None or pending.expires <= time.monotonic():
            raise LocalError(410, "This upload session expired. Select the video again.")
        if request.headers.get("content-length") != str(pending.size):
            raise LocalError(400, "Video size does not match its upload registration.")

        async def bounded_stream():
            total = 0
            async for chunk in request.stream():
                total += len(chunk)
                if total > pending.size:
                    raise LocalError(413, "Video exceeds its registered size.")
                yield chunk
            if total != pending.size:
                raise LocalError(400, "Video upload was incomplete.")

        await cloud.upload(pending.url, {"content-type": pending.content_type,
                           "content-length": str(pending.size), "x-goog-if-generation-match": "0"}, bounded_stream())
        value = await cloud.api("POST", f"/v1/assets/{key}/complete")
        uploads.pop(key, None)
        return value

    @app.post("/api/jobs", status_code=202)
    async def create_job(body: JobInput, idempotency_key: str = Header(min_length=1, max_length=128)):
        if not idempotency_key.strip():
            raise LocalError(400, "An idempotency key is required.")
        # The deployed single-checkpoint API predates the public alias. Translate only
        # the validated Elanus ID; preserve legacy request bodies and idempotency keys.
        return await cloud.api("POST", "/v1/jobs", body=body.model_dump(mode="json", exclude={"model"}),
                               idempotency_key=idempotency_key)

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: UUID):
        return await cloud.api("GET", f"/v1/jobs/{job_id}")

    @app.get("/api/jobs/{job_id}/result")
    async def get_result(job_id: UUID):
        return await cloud.result(str(job_id))

    @app.post("/api/jobs/{job_id}/cancel", status_code=202)
    async def cancel_job(job_id: UUID):
        return await cloud.api("POST", f"/v1/jobs/{job_id}/cancel")

    @app.delete("/api/assets/{asset_id}", status_code=204)
    async def delete_asset(asset_id: UUID):
        await cloud.api("DELETE", f"/v1/assets/{asset_id}")
        uploads.pop(str(asset_id), None)
        return Response(status_code=204)

    return app


if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3000, choices=range(1024, 65536), metavar="PORT")
    parser.add_argument("--sample", type=Path, default=SAMPLE, help="Optional local video to use as the sample")
    args = parser.parse_args()
    print(f"Tayra Labs: http://127.0.0.1:{args.port} — private local testing; no GPU lifecycle changes", flush=True)
    uvicorn.run(create_app(port=args.port, sample=args.sample), host="127.0.0.1", port=args.port,
                access_log=False, log_level="critical")
