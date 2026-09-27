# Ten-minute private playground session

The user approved **ten usable minutes after GPU readiness**, in addition to cold startup, with an estimated total compute cost of approximately $1 before credits. This is not a hard billing cap. The target remains only `video-api-dev-509820`, `us-central1`.

## Startup

- Queue preflight: empty and PAUSED; no old work was dispatched.
- The local playground remained running at <http://127.0.0.1:3000>.
- A reviewed Terraform plan contained only two in-place changes: GPU manual-zero → automatic scaling with maximum one instance, and API `ANALYSIS_ENABLED=false` → `true`. Applied successfully around 22:25 UTC.
- The command-line `gpu_paused=false` override is temporary. The local `terraform.tfvars` intentionally remains `gpu_paused=true` so the desired resting configuration is paused.
- No model, images, IAM, customer data or public-access policies were changed.
- An authenticated GPU health request triggers startup; it does not submit inference. The queue remains paused until the worker responds healthy.

## Independent shutdown safeguard

The local process was armed **before** the resume operation at approximately **2026-09-26 22:24:34 UTC**, under `caffeinate`:

```bash
.venv/bin/python scripts/pause_gpu.py --after-seconds 600 \
  --ready-file /private/tmp/video-api-test-window.09P5p8/ready \
  --startup-timeout 900 --disable-api
```

Exec session: `66400`. It waits up to fifteen minutes for the fresh readiness marker, then allows 600 seconds. If startup readiness is never confirmed, it pauses instead of leaving the GPU running. At the deadline it pauses the queue, sets the GPU to manual zero, and disables new analysis on the CPU API. These are best-effort local controls: keep the computer on and connected; in-flight work can continue briefly and storage remains billable.

GPU health returned ready at 2026-09-26 22:34:37 UTC after 557.7 seconds of probing. Queue dispatch was resumed and confirmed RUNNING, and the existing browser page was refreshed without losing its selected video or prompt. The page now shows Analysis is enabled and an enabled Analyze video button.

The watchdog confirmed its timer started at **2026-09-26 22:36:08.415 UTC**. The requested automatic pause deadline is **2026-09-26 22:46:08.415 UTC**, or **5:46:08 PM America/Chicago**. The readiness marker records this confirmed timer start and deadline. It is specific to this session; do not reuse it.

The chat follow-up `verify-molmo-test-shutdown` checks the actual paused state after the deadline, reconciles only scoped Terraform differences, and stops after confirmation. It must not resume compute or interfere with later sessions.

## Validation

The extended pause script has seven passing tests, including readiness-delayed countdown, bounded startup failure and explicitly scoped API disabling. Full Python suite: 54 passing tests.

## Confirmed shutdown

- The independent watchdog exited successfully (session `66400`, exit code 0), confirming the queue pause, manual-zero GPU scaling, and disabled API analysis.
- GPU scaling updated at **2026-09-26 22:46:10.442 UTC**, approximately two seconds after the requested deadline. The service is reconciled with `scalingMode=MANUAL` and `manualInstanceCount=0`.
- Cloud Tasks queue `video-api-analysis` is **PAUSED**.
- Both the deployed CPU API environment and authenticated `/health` report analysis disabled.
- Cloud Monitoring at **22:47:00 UTC** reports **active=0, idle=0** for GPU revision `video-api-gpu-00001-gtg`.
- Follow-up automation `verify-molmo-test-shutdown` is **PAUSED**, so it will not interfere with later sessions.
- The post-session Terraform plan showed only removal of the CPU API's `gcloud` client/client-version metadata; no GPU, IAM, data, or other resource changes were planned. That narrowly scoped reconciliation completed successfully: zero resources added, one CPU API metadata update, zero destroyed.

No model inference was submitted by the shutdown verification, and no customer sources/results were deleted. Storage and non-GPU service usage remain potentially billable.
