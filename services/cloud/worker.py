from __future__ import annotations

import os
from contextlib import asynccontextmanager
from threading import Timer
from uuid import UUID

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from .api import BodyLimit, make_service
from .config import Settings
from .runner import Runner
from .service import Problem


class TaskInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: UUID


def create_app(runner: Runner | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if runner is None:
            from services.inference.src.model import MolmoRuntime
            settings = Settings.from_env()
            runtime = MolmoRuntime(settings.model_id, settings.model_revision, model_path=settings.model_path)
            app.state.runner = Runner(make_service(settings), runtime)
        yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(BodyLimit)
    if runner is not None:
        app.state.runner = runner

    @app.exception_handler(Problem)
    async def problem_handler(request, error: Problem):
        return JSONResponse({"error": error.code}, status_code=error.status)

    @app.get("/health")
    def health():
        return {"status": "ready"}

    @app.post("/internal/process")
    def process(body: TaskInput):
        current = app.state.runner
        # Cloud Run request timeouts do not terminate CUDA work. Kill a stuck instance before its lease expires.
        watchdog = Timer(current.service.settings.execution_timeout_seconds, lambda: os._exit(124))
        watchdog.daemon = True
        watchdog.start()
        try:
            return current.process(str(body.job_id))
        finally:
            watchdog.cancel()

    return app


# Authentication is enforced by Cloud Run IAM. Terraform grants invocation only to the Tasks identity.
app = create_app()
