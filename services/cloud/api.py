import hmac
import logging
from dataclasses import dataclass
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from .config import API_MODEL_ID, MODEL_ID, MODEL_REVISION, ApiModel, Settings
from .service import Problem, Service, public_asset, public_job
from .identity import FirebaseIdentity, Principal, SESSION_SECONDS, require_verified
from .accounts import account, save_account


@dataclass(frozen=True)
class Caller:
    service: Service
    principal: Principal


class SessionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id_token: str = Field(min_length=1, max_length=8192)


class ProfileInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    display_name: str = Field(min_length=1, max_length=80, pattern=r"^[^\x00-\x1f\x7f]+$")


class AssetInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=100)
    size_bytes: StrictInt = Field(gt=0, le=500 * 1024 * 1024)


class JobInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    model: ApiModel = API_MODEL_ID
    asset_id: UUID
    prompt: str = Field(min_length=1, max_length=4000)
    max_new_tokens: StrictInt = Field(default=512, ge=1, le=2048)


class BodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        consumed = 0

        async def limited_receive():
            nonlocal consumed
            message = await receive()
            if message["type"] == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > 32768:
                    raise HTTPException(413, "JSON request exceeds 32 KiB; upload video directly to storage")
            return message
        await self.app(scope, limited_receive if scope["type"] == "http" else receive, send)


def make_service(settings: Settings) -> Service:
    from .google import FirestoreStore, GoogleObjects, GoogleTasks
    return Service(settings, FirestoreStore(settings), GoogleObjects(settings), GoogleTasks(settings))


def create_app(service: Service | None = None, identity=None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if service is None:
            settings = Settings.from_env()
            if settings.allow_pilot_key and len(settings.api_key) < 32:
                raise RuntimeError("API_KEY must contain at least 32 characters")
            app.state.service = make_service(settings)
        app.state.identity = identity or FirebaseIdentity(app.state.service.settings.project_id)
        yield

    app = FastAPI(title="Video Analysis API", version="0.2.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    if service is not None:
        app.state.service = service
        app.state.identity = identity or FirebaseIdentity(service.settings.project_id)
    app.add_middleware(BodyLimit)
    import os
    app.add_middleware(CORSMiddleware,
                       allow_origins=[service.settings.allowed_origin if service else os.getenv("ALLOWED_ORIGIN", "http://localhost:3000")],
                       allow_methods=["GET", "POST", "PATCH", "DELETE"],
                       allow_headers=["Authorization", "Content-Type", "Idempotency-Key"])

    @app.exception_handler(Problem)
    async def problem_handler(request: Request, error: Problem):
        return JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=error.status)

    @app.exception_handler(Exception)
    async def unexpected_handler(request: Request, error: Exception):
        # Do not log signed URLs, request bodies, API keys, or cloud credential errors.
        logging.getLogger(__name__).error("Request failed: %s", type(error).__name__)
        return JSONResponse({"error": {"code": "internal_error", "message": "Internal server error"}}, status_code=500)

    @app.middleware("http")
    async def response_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["cache-control"] = "no-store"
        response.headers["x-content-type-options"] = "nosniff"
        return response

    def authenticated(request: Request, authorization: Annotated[str | None, Header()] = None) -> Caller:
        current = request.app.state.service
        expected = current.settings.api_key
        if current.settings.allow_pilot_key and expected and hmac.compare_digest(authorization or "", f"Bearer {expected}"):
            return Caller(current, Principal("pilot", "", True, pilot=True))
        scheme, _, token = (authorization or "").partition(" ")
        if scheme not in {"Bearer", "Session"} or not token or len(token) > 8192:
            raise Problem(401, "unauthorized", "Sign in to continue")
        principal = request.app.state.identity.verify(token, session=scheme == "Session")
        return Caller(current, principal)

    Auth = Annotated[Caller, Depends(authenticated)]

    def verified(caller: Auth) -> Caller:
        require_verified(caller.principal)
        return caller

    Verified = Annotated[Caller, Depends(verified)]

    @app.post("/v1/auth/session")
    def login(body: SessionInput, request: Request):
        cookie, principal = request.app.state.identity.create_session(body.id_token)
        user = save_account(request.app.state.service, principal)
        return {"session_cookie": cookie, "expires_in": SESSION_SECONDS, "user": user}

    @app.get("/v1/me")
    def me(caller: Auth):
        if caller.principal.pilot:
            raise Problem(401, "user_required", "Sign in with a user account")
        return {"user": account(caller.service, caller.principal)}

    @app.patch("/v1/me")
    def update_me(body: ProfileInput, caller: Auth):
        if caller.principal.pilot:
            raise Problem(401, "user_required", "Sign in with a user account")
        return {"user": save_account(caller.service, caller.principal, body.display_name)}

    @app.post("/v1/auth/logout-all", status_code=204)
    def logout_all(request: Request, caller: Auth):
        if caller.principal.pilot:
            raise Problem(401, "user_required", "Sign in with a user account")
        request.app.state.identity.revoke(caller.principal.uid)
        return Response(status_code=204)

    @app.get("/health")
    def health(request: Request):
        settings = request.app.state.service.settings
        return {"status": "ok", "service": settings.product_name, "model": settings.model_id,
                "api_model_id": API_MODEL_ID if (settings.model_id, settings.model_revision) ==
                    (MODEL_ID, MODEL_REVISION) else None,
                "model_revision": settings.model_revision, "analysis_enabled": settings.analysis_enabled}

    @app.get("/openapi.json")
    def openapi(caller: Auth):
        schema = app.openapi()
        schema["info"]["title"] = caller.service.settings.product_name
        return schema

    @app.post("/v1/assets", status_code=201)
    def create_asset(body: AssetInput, caller: Verified):
        return caller.service.create_asset(body.filename, body.content_type.lower(), body.size_bytes, caller.principal.tenant)

    @app.post("/v1/assets/{asset_id}/complete")
    def complete_asset(asset_id: UUID, caller: Verified):
        return caller.service.complete_asset(str(asset_id), caller.principal.tenant)

    @app.post("/v1/assets/{asset_id}/upload-url")
    def upload_ticket(asset_id: UUID, caller: Verified):
        return caller.service.upload_ticket(str(asset_id), caller.principal.tenant)

    @app.get("/v1/assets/{asset_id}")
    def get_asset(asset_id: UUID, caller: Verified):
        return {"asset": public_asset(caller.service.asset(str(asset_id), caller.principal.tenant))}

    @app.delete("/v1/assets/{asset_id}", status_code=204)
    def delete_asset(asset_id: UUID, caller: Verified):
        caller.service.delete_asset(str(asset_id), caller.principal.tenant)
        return Response(status_code=204)

    @app.post("/v1/jobs", status_code=202)
    def create_job(body: JobInput, caller: Verified,
                   idempotency_key: Annotated[str, Header(min_length=1, max_length=128)]):
        if not idempotency_key.strip():
            raise Problem(400, "idempotency_key_required", "Idempotency-Key cannot be blank")
        return caller.service.create_job(str(body.asset_id), body.prompt, body.max_new_tokens, idempotency_key, caller.principal.tenant)

    @app.get("/v1/jobs")
    def list_jobs(caller: Verified):
        return {"jobs": [public_job(job) for job in caller.service.store.recent_jobs(caller.principal.tenant)]}

    @app.get("/v1/jobs/{job_id}")
    def get_job(job_id: UUID, caller: Verified):
        current = caller.service
        current.job(str(job_id), caller.principal.tenant)
        current.reconcile(str(job_id))
        return {"job": public_job(current.job(str(job_id), caller.principal.tenant))}

    @app.post("/v1/jobs/{job_id}/cancel", status_code=202)
    def cancel_job(job_id: UUID, caller: Verified):
        return {"job": caller.service.cancel(str(job_id), caller.principal.tenant)}

    @app.get("/v1/jobs/{job_id}/result")
    def result(job_id: UUID, caller: Verified):
        return caller.service.result(str(job_id), caller.principal.tenant)

    @app.post("/internal/maintenance")
    def maintenance(request: Request, authorization: Annotated[str | None, Header()] = None):
        # The public API has its own bearer-key auth. Scheduler uses a separate Google-signed identity.
        from google.auth.transport.requests import Request as GoogleRequest
        from google.oauth2 import id_token
        expected_identity = os.getenv("MAINTENANCE_SERVICE_ACCOUNT", "")
        audience = os.getenv("MAINTENANCE_AUDIENCE", "")
        if not expected_identity or not audience or not authorization or not authorization.startswith("Bearer "):
            raise Problem(401, "unauthorized", "Scheduler identity required")
        try:
            claims = id_token.verify_oauth2_token(authorization[7:], GoogleRequest(), audience=audience)
            if claims.get("email") != expected_identity or claims.get("email_verified") is not True:
                raise ValueError("Wrong scheduler identity")
        except Exception:
            raise Problem(401, "unauthorized", "Invalid scheduler identity") from None
        return request.app.state.service.maintenance()

    return app


app = create_app()
