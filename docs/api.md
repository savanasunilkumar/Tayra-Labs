# Private pilot API

> This page describes the existing Cloud Run pilot deployment. The new account-aware source/local API uses Google Identity Platform and UID-scoped ownership instead of a shared customer key. See [authentication and rollout boundaries](authentication.md). Cloud deployment is still pending; never publish the legacy operator bridge.

This is a single-tenant pilot, not a public customer billing service. The current deployment is IAM-private: every request needs an authorized Google identity token in `X-Serverless-Authorization: Bearer <identity token>`. Application endpoints additionally require `Authorization: Bearer <pilot key>`; `/health` does not require the pilot key. Obtain the key from Secret Manager; do not embed it in a website, commit it, or paste it into logs. Google's organization access restriction prevented public invocation; it was not bypassed. The smoke client supports `--google-auth` for this private pilot. [Google documents the two-header authentication pattern](https://docs.cloud.google.com/run/docs/authenticating/service-to-service).

## Analyze a video

1. `POST /v1/assets` with JSON containing `filename`, `content_type` and exact `size_bytes`.
2. PUT the video bytes to the returned `upload.url`, including all returned `upload.headers`. This goes directly to private Cloud Storage, not through the API. The URL expires after 15 minutes and cannot overwrite an existing object.
3. `POST /v1/assets/{asset_id}/complete` after the upload succeeds.
4. `POST /v1/jobs`, passing a unique `Idempotency-Key` header and the JSON below.
5. Poll `GET /v1/jobs/{job_id}` until the job reaches a terminal status.
6. On `succeeded`, call `GET /v1/jobs/{job_id}/result` and fetch its short-lived `result_url`.

Example asset request (replace the size with the actual file size):

```json
{"filename": "sample.mp4", "content_type": "video/mp4", "size_bytes": 326478}
```

Example job request:

```json
{
  "asset_id": "<UUID from the asset response>",
  "prompt": "Describe the main events in this video.",
  "max_new_tokens": 512
}
```

Asset responses use an `asset` object. Job responses use a `job` object; creation also returns `replayed` to indicate an idempotent replay. Signed URLs are temporary credentials: do not log them or share them publicly.

Reuse the **same** Idempotency-Key and the **same** job request after an ambiguous timeout or a `queue_unavailable` response. Creating a new asset/key starts new work and can incur another charge. Reusing the key with different inputs returns `409 idempotency_conflict`.

The included [smoke client](../scripts/smoke_google.py) runs this flow and reports model output and measured runtime. It performs real, potentially billable inference when connected to a deployed GPU worker.

## Limits and lifecycle

- MP4, MOV and WebM, at most 500 MiB and five minutes per video. Duration/decoding checks run in the worker; a registered upload is not proof of a valid video.
- Prompt: 1–4,000 characters. Output limit: 1–2,048 tokens, default 512. This does not promise the model will use the whole allowance.
- Ten active jobs per pilot tenant, one GPU worker/dispatch at a time in the initial deployment.
- Pending work can be `submitting` or `queued`; executing work is `running`. Terminal statuses are `succeeded`, `failed`, `timed_out`, or `cancelled`.
- `POST /v1/jobs/{job_id}/cancel` requests cancellation. Running GPU work may finish at a safe boundary and can still incur cost; `cancel_requested` is not an immediate shutdown.
- `GET /v1/assets/{asset_id}` checks an asset. `DELETE /v1/assets/{asset_id}` removes its source when no active job uses it.
- Source retention is 24 hours, with cleanup protecting active work; a two-day bucket lifecycle is the backstop. Results are retained for 30 days, with a 31-day bucket lifecycle backstop. Cleanup is asynchronous, not exact-to-the-second deletion.
- The authenticated `GET /openapi.json` endpoint provides the request schema. `/internal/maintenance` accepts the configured Google Scheduler identity, not the pilot key.

When deployed API-only or paused through Terraform, health reports `analysis_enabled: false` and new jobs return `503 analysis_unavailable` without creating work. An emergency queue/GPU pause can precede that API configuration change; do not submit more work until the deployment is reconciled. Health indicates API/configuration availability, not GPU readiness or a latency guarantee.

## Model and measurements

The public release is **Elanus 1 · 8B**, in the **Elanus** family, with API ID **`elanus-1-8b`**. The cloud source now accepts an optional `model: "elanus-1-8b"` on job creation (also the default); unknown IDs return 422. New job/result records include `model` for the public alias while `model_id` and `model_revision` remain checkpoint provenance. Existing records are not migrated or rewritten. Omitted and explicit default model IDs share the same idempotency semantics.

**Deployment boundary:** those cloud changes have not been deployed. The existing deployment still selects the checkpoint automatically and does not accept the new `model` field. The authenticated local adapter validates and translates the alias for that deployment, without changing existing request bodies or keys. The workspace’s copyable cloud examples omit the field until `/health` advertises `api_model_id: "elanus-1-8b"`. An approved API/worker deployment is needed before advertising explicit model selection on the remote endpoint.

The configured checkpoint is `allenai/Molmo2-8B`, pinned to revision `e28fa28597e5ec5e0cca2201dd8ab33d48bc4a1b`. The result contains generated text and measured video duration, generation time, worker time, output tokens and peak allocated GPU memory. Model answers can be wrong; this pilot does not establish parity with Twelve Labs, semantic-search support or audio transcription.

Runtime measurements are not a billing invoice. Cold starts, idle GPU time, retries/failures, storage and other services matter. Neither startup credits nor the proposed retail price proves a 45% gross margin.
