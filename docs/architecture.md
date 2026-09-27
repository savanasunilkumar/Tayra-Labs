# Google-only pilot architecture

## Request flow

```text
Client -> Cloud Run CPU API -> signed PUT -> private Cloud Storage
              |
              +-> Firestore: reserve owned asset + job + idempotency key
              +-> Cloud Tasks (Google OIDC identity)
                         |
                         v
                 Private Cloud Run GPU
                 Molmo2-8B + ffprobe
                         |
                         +-> immutable result in Cloud Storage
                         +-> Firestore completion + attempt + usage

Client -> API polling -> short-lived signed result GET
Cloud Scheduler -> authenticated API maintenance -> reconciliation + cleanup
```

The API never proxies video bytes. Worker task bodies contain only a job ID; source keys, generations and prompts are read from Firestore. There are no client-supplied remote URLs. No Cloudflare or RunPod dependency is used by this path.

## Model and resource configuration

The Google worker is fixed to `allenai/Molmo2-8B`, revision `e28fa28597e5ec5e0cca2201dd8ab33d48bc4a1b`. A CPU-only staging job streams the pinned snapshot into a separate private model bucket; the worker mounts it read-only and validates the snapshot completion marker before loading. Custom model code is enabled for this pinned revision; it still needs a security/license review before commercial launch.

The initial GPU configuration is RTX PRO 6000 with 96 GB VRAM, 20 vCPU, 80 GiB RAM, one concurrent request, minimum zero and maximum one instance. It follows [Google's documented GPU requirements](https://docs.cloud.google.com/run/docs/configuring/services/gpu). This is a benchmark configuration, not a proven throughput or margin recommendation. The runtime preserves the checkpoint's automatic dtype and does not silently quantize.

## Pilot contract

- Visual analysis of MP4, MOV and WebM, up to 500 MiB and five minutes.
- Metadata validation rejects unreadable video metadata, excessive dimensions/frame rate and unsupported containers before generation. Decoder errors can still occur during frame extraction.
- Prompt up to 4,000 characters; output up to 2,048 tokens, default 512.
- Ten active jobs per pilot tenant; one GPU instance processes one job at a time.
- Queue lifetime two hours; worker watchdog 25 minutes; transaction lease and task dispatch deadline 30 minutes.
- Source retention 24 hours from registration, protected while a job is active. Result retention 30 days.
- Scheduler runs every five minutes. Storage lifecycle rules are a two-day source / 31-day result backstop.
- Job/asset/usage metadata remains for audit; metadata retention policy is a launch gate.
- All API timestamps are Unix seconds.

The authenticated OpenAPI schema is at `GET /openapi.json`. Customer routes:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | /v1/assets | Register file; receive signed PUT URL and required headers |
| POST | /v1/assets/{id}/complete | Validate stored size/type; pin object generation |
| GET / DELETE | /v1/assets/{id} | Inspect / delete an inactive owned asset |
| POST | /v1/jobs | Analyze an asset; requires Idempotency-Key |
| GET | /v1/jobs/{id} | Poll and reconcile status |
| POST | /v1/jobs/{id}/cancel | Cancel pending work or request cooperative cancellation |
| GET | /v1/jobs/{id}/result | Get a short-lived result URL after success |

Job states: `submitting -> queued -> running -> succeeded | failed | timed_out`; cancellation passes through `cancel_requested` to `cancelled`. Reusing an idempotency key with different inputs returns 409.

## Security and reliability

The CPU service uses one Secret Manager-backed bearer key for a trusted pilot only. Its current deployment is additionally IAM-private because Google rejected public invocation under an organization access restriction; that restriction was not changed. Pilot clients present an authorized Google identity separately from the application key. Domain methods enforce tenant ownership, but customer onboarding and separate organization keys are not implemented. The private GPU service relies on Cloud Run IAM: only the Tasks identity receives an explicit service-level invoker permission (project-level administrators can retain inherited access). Its URL must never be made public. Scheduler uses a separate verified Google OIDC identity, an API service invoker grant and a configured custom audience, not the customer API key.

Upload URLs expire after 15 minutes and require a signed generation-match-zero header, preventing overwrites. The worker downloads the validated generation with a bounded range. A signed PUT does not enforce the declared upload size before storage: an oversized object can incur temporary storage cost, then be rejected. Do not give the pilot key to untrusted customers.

Firestore transactions reserve active-job slots and claim one inference attempt. An enqueue timeout leaves a durable `submitting` record; retries reuse the task UUID. A saved immutable result can recover a lost completion write without invoking the model again. An expired running lease ends the job rather than automatically repeating expensive inference. A new client job with a new idempotency key is new paid work.

Cancellation cannot interrupt a CUDA kernel immediately; it is checked at safe boundaries. A process watchdog terminates stuck work before the lease expires. Failed and cancelled attempts are recorded; hard crashes can leave incomplete measurements. The one-instance setting is not a spending cap, and repeated cold starts or provider failures can still cost money.

Media soft deletion is explicitly disabled to support ephemeral-video deletion. Firestore deletion protection is enabled, buckets are not force-destroyable, and service deletion protection prevents accidental removal. Keep Terraform state private; this pilot starts with local state, which must be backed up and migrated to a restricted remote backend before team operation.

## Pricing verification and launch gates

At proposed revenue of $1.49 per processed video-hour, a 45% gross margin requires:

```text
maximum fully loaded COGS = 1.49 * (1 - 0.45) = $0.8195/video-hour
gross margin = (revenue - fully loaded COGS) / revenue
```

Usage records include video duration, generation milliseconds, output tokens, peak PyTorch-allocated VRAM and worker milliseconds when available. Generation time excludes decoding and model startup; worker time excludes cold startup, idle capacity and some completion overhead. Neither equals the cloud bill. Reconcile representative warm/cold/failed runs with GPU + CPU + RAM instance billing, storage, egress, database/queue/logging, payment fees and other attributable costs. Credits reduce cash outlay, not sustainable COGS.

Before selling access:

- Build both images and run deployed integration/security tests, including denied unauthenticated GPU invocation.
- Benchmark real videos for quality, long-video behavior, cold starts, VRAM and fully loaded cost; do not promise Twelve Labs parity.
- Add organization-scoped hashed API keys, revocation, rate limits, upload limits, prepaid reservations and hard usage quotas.
- Add billing, customer usage reports, monitoring/alerts, an operational stop procedure, backup/recovery and a privacy/deletion policy.
- Establish model/code/license and data-processing clearance, including appropriate source-video rights.

Search indexing, grounding/tracking, audio transcription, webhooks and a web dashboard are outside this milestone.
