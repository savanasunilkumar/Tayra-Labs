from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit
from uuid import UUID


class InputValidationError(ValueError):
    """Raised when a submitted RunPod job violates the public contract."""


@dataclass(frozen=True)
class JobInput:
    job_id: str
    video_url: str
    result_put_url: str
    prompt: str
    mode: str
    model_id: str
    model_revision: str
    max_new_tokens: int
    max_download_bytes: int
    expected_bytes: int


def _required_string(payload: dict[str, object], key: str, max_length: int) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise InputValidationError(
            f"{key} must be a non-empty string of at most {max_length} characters"
        )
    return value.strip()


def _bounded_integer(
    payload: dict[str, object], key: str, minimum: int, maximum: int
) -> int:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise InputValidationError(f"{key} must be an integer")
    if value < minimum or value > maximum:
        raise InputValidationError(f"{key} must be between {minimum} and {maximum}")
    return value


def _validate_signed_r2_url(value: str, allowed_host_suffix: str) -> str:
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower()
    suffix = allowed_host_suffix.lower()
    if parsed.scheme != "https" or not host.endswith(suffix):
        raise InputValidationError("object URLs must be HTTPS URLs on the configured R2 host")
    if parsed.username or parsed.password or parsed.fragment or not parsed.path:
        raise InputValidationError("object URL contains unsupported components")
    query = parse_qs(parsed.query)
    required_signature_fields = {
        "X-Amz-Algorithm",
        "X-Amz-Credential",
        "X-Amz-Date",
        "X-Amz-Expires",
        "X-Amz-Signature",
    }
    if not required_signature_fields.issubset(query):
        raise InputValidationError("object URL is not a complete presigned R2 URL")
    return value


def validate_job(
    job: object,
    *,
    allowed_host_suffix: str,
    hard_max_download_bytes: int,
) -> JobInput:
    if not isinstance(job, dict):
        raise InputValidationError("job must be an object")
    payload = job.get("input")
    if not isinstance(payload, dict):
        raise InputValidationError("job.input must be an object")

    job_id = _required_string(payload, "job_id", 100)
    try:
        UUID(job_id)
    except ValueError as exc:
        raise InputValidationError("job_id must be a UUID") from exc

    mode = _required_string(payload, "mode", 30)
    if mode != "standard":
        raise InputValidationError("only standard analysis is enabled")

    max_download_bytes = _bounded_integer(
        payload, "max_download_bytes", 1, hard_max_download_bytes
    )
    expected_bytes = _bounded_integer(
        payload, "expected_bytes", 1, max_download_bytes
    )

    return JobInput(
        job_id=job_id,
        video_url=_validate_signed_r2_url(
            _required_string(payload, "video_url", 8_192), allowed_host_suffix
        ),
        result_put_url=_validate_signed_r2_url(
            _required_string(payload, "result_put_url", 8_192), allowed_host_suffix
        ),
        prompt=_required_string(payload, "prompt", 4_000),
        mode=mode,
        model_id=_required_string(payload, "model_id", 200),
        model_revision=_required_string(payload, "model_revision", 64),
        max_new_tokens=_bounded_integer(payload, "max_new_tokens", 1, 2_048),
        max_download_bytes=max_download_bytes,
        expected_bytes=expected_bytes,
    )
