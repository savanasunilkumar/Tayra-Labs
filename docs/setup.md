# Google-only setup and deployment

The selected Google project is `video-api-dev-509820`; the product name is still undecided. **Do not deploy to the CLI's existing Aniflixx project by default**. Bootstrap resources and the API-key secret have been created, and remote image builds/model staging have started under the approved estimated $10 initial test budget before credits. Credit eligibility and usable GPU quota remain unconfirmed. See [preflight status](preflight.md) for actual deployment progress; the remaining sections describe the deployment procedure, not proof that every stage has completed.

## 1. Local checks — no cloud account required

Use Python 3.12+ and Terraform 1.6+ (validated here with Terraform 1.16.4 and the locked Google provider).

```bash
python3 -m venv .venv
.venv/bin/pip install -r services/cloud/requirements-dev.txt
.venv/bin/pytest -q
.venv/bin/ruff check services/cloud services/inference/src/model.py scripts
terraform -chdir=infra/google init -backend=false
terraform -chdir=infra/google validate
```

Tests use in-memory storage/queue/model adapters. They are not a substitute for deployed integration tests or a GPU benchmark. The active service is Python; Node/pnpm is only needed for the preserved legacy Cloudflare implementation.

## 2. Choose the account/project — required before remote work

The selected dedicated project is `video-api-dev-509820`. Confirm it is attached to the billing account that holds the startup credits. Verify the credit's service eligibility, remaining balance and expiry in Billing. Startup credits do not automatically establish GPU quota or guarantee that every charge is covered.

In that project, check Cloud Run RTX PRO 6000 quota/capacity in `us-central1`. The default worker needs one GPU, 20 vCPU and 80 GiB RAM. Confirm a billing budget/alerts and who will receive them; budget alerts are not a hard spend cap. Review [Google's GPU setup guide](https://docs.cloud.google.com/run/docs/configuring/services/gpu).

The product name can remain `Video API`. Pick the internal resource prefix before the first apply and keep it stable; changing it later can replace resources. A custom domain is not required for the pilot.

The operator needs permission to enable services, create the listed resources, manage their scoped IAM and act as the service accounts. Use local Google login/ADC, not downloaded service-account keys or credentials pasted into chat:

```bash
gcloud auth login
gcloud auth application-default login
export VIDEO_PROJECT_ID="video-api-dev-509820"
export VIDEO_REGION="us-central1"
export VIDEO_RESOURCE_PREFIX="video-api"
```

Commands below specify the project explicitly instead of changing your existing gcloud default. Stop if the target, billing linkage or quota is unclear.

## 3. Bootstrap infrastructure — creates billable resources

The ignored `infra/google/terraform.tfvars` is already configured locally for `video-api-dev-509820`. Review its display name, prefix and allowed browser origin. On a fresh checkout, copy `infra/google/terraform.tfvars.example` to that path and set the selected project ID. Keep `deploy_services = false` and `create_staging_job = false` until the later stages explicitly enable them.

```bash
terraform -chdir=infra/google plan
terraform -chdir=infra/google apply
```

Review the plan before approving. This creates service accounts, a named Firestore database, private media/model/build buckets, a task queue, a container registry and an empty API-key secret. It does not yet create a GPU service.

Terraform state starts locally; store it securely, back it up and move it to a restricted remote backend before multiple operators use Terraform. Keep the provider lock file in version control. Do not commit state, plan files, secrets or real tfvars.

## 4. Build immutable CPU and GPU images — incurs build/storage cost

Run from the repository root. Inspect the upload file list first and ensure it contains no private files. The ignore files exclude known secrets, model/build caches and Terraform state.

```bash
gcloud meta list-files-for-upload

gcloud builds submit . \
  --project="$VIDEO_PROJECT_ID" \
  --region="$VIDEO_REGION" \
  --config=cloudbuild.yaml \
  --gcs-source-staging-dir="gs://$VIDEO_PROJECT_ID-$VIDEO_RESOURCE_PREFIX-builds/source" \
  --substitutions="_REGION=$VIDEO_REGION,_RESOURCE_PREFIX=$VIDEO_RESOURCE_PREFIX,_TAG=pilot-v1"
```

The custom build identity has registry write, build-source read and logging permissions. Builds use Google's Linux AMD64 infrastructure, including when your laptop is Apple Silicon. See the [Cloud Build submit reference](https://docs.cloud.google.com/sdk/gcloud/reference/builds/submit).

Get each image description and copy the full digest-qualified image reference into `api_image` and `worker_image` in your local tfvars:

```bash
gcloud artifacts docker images describe \
  "$VIDEO_REGION-docker.pkg.dev/$VIDEO_PROJECT_ID/$VIDEO_RESOURCE_PREFIX/api:pilot-v1" \
  --project="$VIDEO_PROJECT_ID"

gcloud artifacts docker images describe \
  "$VIDEO_REGION-docker.pkg.dev/$VIDEO_PROJECT_ID/$VIDEO_RESOURCE_PREFIX/worker:pilot-v1" \
  --project="$VIDEO_PROJECT_ID"
```

Use `.../api@sha256:...` and `.../worker@sha256:...`, not mutable tags. Terraform checks this. See [image descriptions](https://docs.cloud.google.com/sdk/gcloud/reference/artifacts/docker/images/describe). Do not enable the services yet.

## 5. Seed the API secret and stage the pinned model

Create a random key directly in Secret Manager without printing it or placing it in Terraform state. Do not run the shell with command tracing enabled:

```bash
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add \
  "$VIDEO_RESOURCE_PREFIX-api-key" --project="$VIDEO_PROJECT_ID" --data-file=-
```

Set `create_staging_job = true` in tfvars, leaving `deploy_services = false`, then review/apply. Execute the CPU staging job:

```bash
terraform -chdir=infra/google plan
terraform -chdir=infra/google apply

gcloud run jobs execute "$VIDEO_RESOURCE_PREFIX-stage-model" \
  --project="$VIDEO_PROJECT_ID" --region="$VIDEO_REGION" --wait
```

This streams roughly 35 GB of pinned checkpoint weights plus small supporting files into the model bucket. It costs CPU time and storage but does not start a GPU. It creates `molmo2-8b/e28fa28597e5ec5e0cca2201dd8ab33d48bc4a1b/.complete.json` only after all files upload. A failed staging run may be rerun; already completed files are reused. Investigate unexpected existing model objects before trusting them.

If Hugging Face throttles anonymous downloads, use a read-only token from your own Hugging Face account. Run this locally in an interactive terminal; the prompt hides the token and sends it directly to the dedicated Secret Manager secret:

```bash
.venv/bin/python scripts/store_hf_token.py
```

Then set `enable_hf_auth = true`, apply and execute the staging job again. The secret is available only to the staging service account among the runtime identities, not the public API, image build or GPU service. Do not put the token in tfvars, build arguments, source code, chat or command-line arguments. The downloader respects `Retry-After` and Hugging Face's `RateLimit` reset header and makes a bounded number of retries; authentication does not exempt it from rate limits.

While staging is blocked, `deploy_api_only = true` deploys the CPU API independently. Uploads and authentication work, but health reports `analysis_enabled: false` and new jobs return `503 analysis_unavailable` without reserving work. A CPU-only deployment is not a successful model test.

## 6. Deploy services — begins GPU startup charges

Only after both builds, the API-key version and model staging succeed, set `deploy_services = true` and `gpu_paused = false`. Keep a separate terminal open with the pilot's bounded test-window safeguard before applying:

```bash
.venv/bin/python scripts/pause_gpu.py --after-seconds 2700
```

This local watchdog pauses the task queue and sets the GPU service to manual scaling with zero instances after 45 minutes. Keep the computer awake. It is a best-effort safeguard, not a hard billing cap; already running requests may finish and other resources still have costs. Ctrl-C triggers an early pause. The script intentionally targets only `video-api-dev-509820` in `us-central1`.

```bash
terraform -chdir=infra/google plan
terraform -chdir=infra/google apply
terraform -chdir=infra/google output
```

The CPU API defaults to IAM-private **and** application-key protected. In this project's first deployment Google rejected an `allUsers` invoker binding under an organization access restriction. No organization policy or IAM check was disabled. Keep `public_api_enabled = false` until the organization owner approves a public-access configuration. The Scheduler identity has a narrow service-level invoker grant and a configured custom audience. The GPU URL must remain IAM-private; only the Tasks identity is an explicit invoker. Deployment starts the GPU to check readiness, so it can cost money even before a customer job.

The defaults are zero minimum / one maximum GPU instance and one active task dispatch. Scale-to-zero does not mean zero cost while startup or idle instances remain alive. Do not disable IAM, raise concurrency or increase instance limits to work around a failed smoke test.

## 7. Smoke test and benchmark — performs paid inference

Use a short test video you have permission to process. Set the environment without printing secrets:

```bash
export VIDEO_API_URL="$(terraform -chdir=infra/google output -raw api_url)"
export VIDEO_API_KEY="$(gcloud secrets versions access latest \
  --secret="$VIDEO_RESOURCE_PREFIX-api-key" --project="$VIDEO_PROJECT_ID")"

.venv/bin/python scripts/smoke_google.py /absolute/path/to/sample.mp4 --google-auth
unset VIDEO_API_KEY
```

The client uploads directly to private storage, completes the asset, submits an idempotent job, polls and fetches the result. `--google-auth` adds a short-lived identity token from the signed-in gcloud account in `X-Serverless-Authorization`, while the pilot key stays in `Authorization`. Your Google identity must have Cloud Run invocation permission. Both credentials stay out of output. Omit the flag only for a separately approved public API configuration. The script prints job/asset IDs, model identity, output text and measurements, not signed URLs or the API key. It uses 512 output tokens by default. If a request fails after submission, inspect the printed job or retry its saved Idempotency-Key with the same inputs; running the whole script again creates new work.

Optionally pass `--instance-hourly-usd RATE`, using the current combined GPU + CPU + RAM hourly rate before credits. The result is a **worker-time-only estimate**, not fully loaded COGS. Compare real cold/warm/failure scenarios with billing before accepting $1.49/video-hour and a 45% margin. The fully loaded ceiling is $0.8195/video-hour.

Verify in the deployed environment:

1. IAM-private API rejects unauthenticated calls; with Google authentication, the API still rejects missing/wrong pilot keys. Direct unauthenticated GPU calls are denied.
2. Duplicate job submissions/deliveries do not run inference twice.
3. Oversized, corrupt and over-duration files are rejected.
4. Running cancellation, timeouts and lost completion writes reconcile correctly.
5. Scheduler authentication succeeds; expired objects are cleaned up.
6. Actual GPU memory, model outputs, startup latency and billing are acceptable.

After the initial test, pause new dispatches and disable new GPU instances:

```bash
.venv/bin/python scripts/pause_gpu.py
```

Then set `gpu_paused = true` in tfvars and apply to keep Terraform consistent. Confirm the queue is `PAUSED` and service-level scaling is `MANUAL` with zero instances. [Manual zero disables new service requests](https://docs.cloud.google.com/run/docs/configuring/services/manual-scaling); already running requests may finish. The CPU API, checkpoint and images remain available and can incur small storage/usage charges. Do not run broad `terraform destroy` as an emergency spending switch.

For a separately approved test window, arm the safeguard again, set `gpu_paused = false`, review/apply Terraform, then explicitly resume the queue with `gcloud tasks queues resume video-api-analysis --project=video-api-dev-509820 --location=us-central1`. Paused jobs can dispatch on resume, so inspect queued work first.

## Before paid/public launch

Complete the security, customer keys/quotas, billing, observability, commercial review and cost-validation gates in [architecture](architecture.md). Model quality equivalence to Twelve Labs is not established. A successful local test or Terraform validation does not mean cloud deployment, GPU compatibility or margin is verified.
