# Tayra Labs

A private-pilot asynchronous video-understanding API from **Tayra Labs**, targeting **Google Cloud only**. The model family is **Elanus**, with first release **Elanus 1 · 8B** and API model ID **`elanus-1-8b`**, powered by the unchanged `allenai/Molmo2-8B` checkpoint. The selected deployment project remains `video-api-dev-509820`. Supporting cloud infrastructure is provisioned under an approved estimated $10 first-test budget before credits. See [deployment status](docs/preflight.md) for which live checks have actually completed and [brand decisions](docs/brand.md) for naming boundaries.

## What is implemented

- Bearer-authenticated upload registration, completion, analysis jobs, polling, cancellation and result downloads.
- Private Cloud Storage with short-lived, generation-bound URLs; Firestore transactional job state.
- Cloud Tasks dispatch to a private Cloud Run GPU service with one job per instance.
- Duplicate-delivery protection, cancellation recovery, queue/execution deadlines and scheduled retention cleanup.
- Per-attempt usage records, model revision pinning, container builds and staged Terraform deployment.
- A Next.js product frontend with shadcn/ui and Lucide: overview, video analysis, model details, API keys, documentation and settings, with a bottom profile menu.
- Google Identity Platform accounts, verified email/password login, provider-gated Google login, HttpOnly sessions, account profiles and UID-scoped media/jobs. Source/local implementation is complete; cloud rollout is pending.
- An authenticated server-side workspace adapter with bounded uploads/results, idempotent submission and per-account history. The old shared pilot adapter is retired from the product frontend.

The Google worker uses Molmo2-8B revision `e28fa28597e5ec5e0cca2201dd8ab33d48bc4a1b`. Two live analyses succeeded on one RTX PRO 6000 GPU (96 GB VRAM), 20 vCPU and 80 GiB RAM. The warm ten-second sample used 3.144 seconds of worker time, but cold application startup took approximately nine minutes. The GPU and queue are now paused, and saved results remain available. See [live test results](docs/pilot-results-2026-09-26.md); this is not yet a public/customer-ready product.

## Product frontend

The frontend is in `apps/web`: Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4 and shadcn/ui, with self-hosted Inter typography. Its compact dark shell and flat lists follow directly inspected Linear layouts, while the split video/prompt/response workflow draws from Twelve Labs. The supplied Tayra logo is unchanged. The workspace uses **Elanus 1 · 8B** and retains upstream provenance in model and response details. The local adapter understands `elanus-1-8b`; remote alias support is prepared in source but requires a separate cloud deployment.

With Node 22+ and pnpm 10.32.1, install dependencies with `pnpm install`. Configure the public Firebase web settings and Google developer credentials as described in [authentication setup](docs/authentication.md), then run these in two terminals:

```bash
pnpm dev:api     # Account API on 127.0.0.1:8080; inference disabled
pnpm dev         # Next.js frontend on 127.0.0.1:3100
```

Open [Tayra Labs](http://127.0.0.1:3100/login). `pnpm check:web` checks TypeScript and frontend/security tests; `pnpm build:web` builds the Next.js app.

Account authentication is implemented locally; live access requires valid developer credentials and enabled identity providers. Personal API keys, team accounts, billing and public deployment are separate remaining work. No GPU is resumed by opening or developing the frontend. See [authentication notes](docs/authentication.md) and [frontend notes](docs/frontend.md).

## Earlier testing interface

Start the local playground with the existing development environment:

```bash
.venv/bin/python scripts/playground.py
```

Open the [Tayra Labs playground](http://127.0.0.1:3000). It uses your existing `gcloud` login and retrieves the pilot key from Secret Manager on the server; neither Google tokens nor the pilot key are sent to the browser. No credentials need to be pasted into the page. The process targets only `video-api-dev-509820`, not your CLI's default project.

Choose a video, enter a question, and select **Analyze video** when the deployed API reports analysis enabled. The interface does **not** resume the GPU or change infrastructure. While the GPU is paused, local previews and **View previous test** remain available. Opening a saved result does not submit inference. New analysis uses real cloud resources and can incur charges.

The optional sample uses the pilot clip already on this computer. If it is no longer available, choose a local video or start with `--sample /absolute/path/to/clip.mp4`. Job IDs and filenames are remembered in local browser storage; an interrupted job-submission request is kept in tab session storage so retries use the same idempotency key. No model responses or API keys are stored there. See [playground notes](docs/playground.md).

## Local checks

Python 3.12+ is required. These checks use fake cloud/model adapters; they do not download weights, create Google resources or incur GPU charges.

```bash
python3 -m venv .venv
.venv/bin/pip install -r services/cloud/requirements-dev.txt
.venv/bin/pytest -q
.venv/bin/ruff check services/cloud services/inference/src/model.py scripts
```

Terraform validation does not deploy resources:

```bash
terraform -chdir=infra/google init -backend=false
terraform -chdir=infra/google validate
```

## Repository layout

```text
services/cloud/              Google API, worker, storage/queue adapters and tests
services/inference/src/      Shared video validation and Molmo runtime
services/inference/Dockerfile.google
infra/google/                Google-only Terraform configuration
scripts/smoke_google.py      Deployed API smoke test and cost measurements
scripts/pause_gpu.py         Bounded pilot GPU/queue pause control
scripts/store_hf_token.py    Hidden-input Hugging Face credential setup
scripts/playground.py        Loopback-only authenticated testing bridge
apps/web/                    Next.js + shadcn/ui product frontend
apps/playground/             Earlier HTML testing interface, retained during migration
cloudbuild.yaml             CPU/GPU image builds
docs/                       Setup, architecture and launch gates
```

`apps/api/`, the original inference `Dockerfile`, and its RunPod handler remain as **legacy reference**, not active deployment targets. Old business reports in `outputs/` contain earlier names and assumptions.

## Deployment and limits

The local, ignored `infra/google/terraform.tfvars` targets `video-api-dev-509820`. Google login, billing and the first GPU allocation work. Startup-credit eligibility and future capacity remain unconfirmed. Authenticated model staging completed without exposing the token to the build or API. The CPU API remains IAM-private because an organization access restriction rejected public invocation; no policy was bypassed. The existing Aniflixx project is not selected. The local interface uses Tayra Labs branding. Deployed API display branding is controlled by `product_name` and has not been redeployed for this change; `video-api` remains the stable internal resource prefix.

This is not a public paid service yet: the existing cloud deployment still uses one pilot API key. Customer signup/account management now exists in the local source and requires a reviewed cloud rollout; billing, personal API keys, semantic search and audio transcription remain separate work. The proposed $1.49/video-hour price and 45% margin are targets, not validated economics. Fully loaded COGS must be at most $0.8195/video-hour before credits; the warm short-sample worker-only extrapolation was $1.0019/video-hour, so this test does **not** meet that margin target.

See [API usage](docs/api.md), [setup](docs/setup.md) for the deployment sequence and [architecture](docs/architecture.md) for boundaries and remaining launch gates.
