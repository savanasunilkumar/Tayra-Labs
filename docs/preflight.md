# Deployment status — 2026-09-26

Target: `video-api-dev-509820`, region `us-central1`, internal prefix `video-api`.

## Provisioned and verified

- Project is ACTIVE and billing-enabled. All commands explicitly target it; the CLI's existing Aniflixx default project was not changed.
- Required APIs, service accounts/scoped IAM, private media/model/build buckets, named Firestore database, Cloud Tasks queue, Artifact Registry and Secret Manager are provisioned.
- CPU API is deployed at `https://video-api-api-7pgxmg73ya-uc.a.run.app`, currently **IAM-private with analysis disabled**. It additionally requires the pilot bearer key for application endpoints.
- Live API checks passed: unauthenticated Cloud Run access denied; Google-authenticated health succeeds; missing/wrong pilot key denied; authenticated schema retrieval; signed private upload; overwrite prevention (`412`); upload completion; disabled job submission (`503 analysis_unavailable`); source deletion. Only the public sample's temporary cloud upload was deleted; its local source remains available.
- Scheduler invoked `/internal/maintenance` successfully (`200`); the pilot key alone is rejected on that route (`401`).
- API image built successfully: `api@sha256:fafd515a523db1b5e588c544255ed23f2267c81b136879d57a88a72669ebd7c1`.
- GPU worker image built successfully, including import checks: `worker@sha256:89d62d4cc8cc6179a16b77d8806b64ba4063305151bcd743de1f9f34eec13c9a`.
- Both images are in `us-central1-docker.pkg.dev/video-api-dev-509820/video-api`.
- 34 local tests pass; Ruff and Terraform validation pass. These do not prove GPU runtime compatibility or economics.

## Model staging and GPU status

Model: `allenai/Molmo2-8B`, revision `e28fa28597e5ec5e0cca2201dd8ab33d48bc4a1b`.

Two anonymous staging executions failed with Hugging Face `429` responses, including bounded timed retries. The user supplied a Hugging Face token directly into Secret Manager using the hidden-input helper; it was never pasted into chat or printed. Only the staging service account among the runtime identities can access that secret.

Authenticated execution `video-api-stage-model-2stv5` passed the earlier download failure and stored two weight files. It was cancelled to switch to bounded four-file parallel transfer on 4 CPU/2 GiB. Execution `video-api-stage-model-tbmm6` completed successfully at 21:10:43 UTC. Verification confirmed the pinned identity, all 26 manifest files, all eight weight shards referenced by the safetensors index and 34.66 GB of stored checkpoint data. Network measurements showed approximately 1.8 GB/min overall; parallelism did not raise the total throughput.

The GPU deployment started at approximately 21:11:44 UTC with a 45-minute local pause watchdog, wrapped in macOS `caffeinate -i`. One non-zonal RTX PRO 6000 (96 GB), 20 vCPU/80 GiB became ready at 21:23:15 UTC. This confirms usable capacity for this first deployment, not guaranteed future capacity. Two analyses succeeded; the warm follow-up used 3.144 seconds of worker time for the ten-second sample. Duplicate submission reused the existing result.

The watchdog was stopped early after testing and successfully paused the queue and GPU. Scaling is MANUAL with zero instances, reconciled at 21:27:51 UTC. Monitoring confirms zero active and idle GPU-service instances at 21:29:00 UTC. Terraform is reconciled with `gpu_paused = true`, and API analysis is disabled while saved results remain readable. See [live test results](pilot-results-2026-09-26.md) for output, latency, cost calculations and limitations.

## Access restriction

Google rejected an `allUsers` Cloud Run invoker binding: the principal was not permitted under the organization's access policy. The API remains private; no organization restriction or Cloud Run IAM check was disabled. The signed-in Google account can invoke it, and Scheduler has a narrow service-level grant. A public customer API needs an approved organization-compliant access configuration before launch. `public_api_enabled` defaults to false.

## Budget and credits

The user approved an **estimated $10 first-test budget before credits**. This is not a hard provider cap. Billing delays, startup and in-flight work can cause overshoot. The local pause watchdog is best-effort, requires an awake computer and does not replace billing alerts.

The screenshot showed two Available credits: `2024 GFS Cloud Program - Start`, **$1,874.79** remaining of $2,000; and `Trial credit for GenAI App Builder`, **$1,000** remaining. The screenshot cuts off full usage-scope details and does not show expiry. Their $2,874.79 total is **not verified as a general GPU credit pool**; do not count the GenAI App Builder trial toward Molmo hosting without explicit eligibility. Treat all current usage as potentially billable before credits.

Cloud Build, CPU staging, API requests, GPU startup and retained container/source data can incur costs even before inference. Exact billed spend is not yet verified. Proposed $1.49/video-hour retail pricing and 45% margin remain unvalidated.

## Remaining product gates

The first private end-to-end test is complete, not the customer-facing product. Cold start was approximately nine minutes. The warm sample's worker-only extrapolation is $1.0019/video-hour, above the $0.8195 fully loaded ceiling required for the proposed 45% margin. Longer-video/quality benchmarks, cost optimization, customer identities/quotas/billing, developer UI and approved public access remain. Actual billed spend and credit eligibility are still unverified.

See [setup](setup.md) for commands and [API usage](api.md) for the private-pilot authentication flow.
