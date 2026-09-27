# Tayra Labs playground

The interface is a private development tool for Tayra Labs, not a public deployment. It uses the supplied Tayra logo without altering the artwork. Company branding is separate from model product names, which are still undecided; the underlying model remains explicitly identified as Allen AI’s Molmo2-8B. See [brand decisions](brand.md).

It reuses the existing private Google Cloud pilot and does not introduce Cloudflare, a public proxy, a new authentication provider, or GPU lifecycle controls.

## Start

```bash
.venv/bin/python scripts/playground.py
```

Open <http://127.0.0.1:3000>. Optional arguments are `--port 3001` and `--sample /absolute/path/to/video.mp4`. The optional default sample is the public Allen AI clip previously downloaded during the live pilot. If that temporary file has gone away, the sample control is disabled; local file selection still works.

Python dependencies are the existing `services/cloud/requirements-dev.txt`; no frontend build or external fonts are required. Stop with Ctrl-C in the process's terminal. The bridge binds only to `127.0.0.1` and is not suitable for public hosting, tunnels, or LAN exposure.

## What works

- MP4, MOV and WebM selection, drag-and-drop, local video preview, size checks and browser-readable duration checks. Backend validation remains authoritative, especially for codecs the browser cannot preview.
- Prompt presets, editable questions up to 4,000 characters and 128–2,048 token output limits.
- Authenticated upload registration, bounded streaming upload, immutable cloud storage PUT, completion and idempotent job submission.
- Job polling, explicit cancellation requests, plain-text responses, raw JSON and copy/download controls.
- Prior job IDs and filenames retained in local browser storage. Interrupted submissions retain the exact request/key in tab session storage; retry does not silently create a new analysis.
- A shortcut to the real previously completed pilot job. It fetches the actual saved result; it is not a mocked model response. That result can expire under normal retention.

Selecting a file or loading the sample does not upload it. **Analyze video** registers/uploads the source and submits a real, potentially billable analysis. Sources normally expire after 24 hours and results after 30 days, with asynchronous cleanup. Failed uploads receive best-effort cleanup of only the newly registered source; normal retention remains the backstop.

The API's `analysis_enabled` flag controls submission availability. A second server-side health check prevents new upload registration while analysis is paused. This flag does not prove GPU readiness, warm latency, or the live queue state; emergency pauses must still be reconciled as described in `setup.md`. Opening the UI, refreshing connectivity or reading saved results never resumes the GPU. CPU API/storage operations may still incur small charges.

## Security boundaries

The browser talks only to the local bridge. The bridge retrieves the existing pilot API key and Google identity token using the user's `gcloud` login, with every cloud command explicitly targeting `video-api-dev-509820`. Tokens remain in process memory, refresh after 45 minutes, and are not printed or persisted by the bridge. Existing Google Cloud IAM policies remain enforced; the organization restriction on public invocation is unchanged.

The bridge checks the Host, Origin, cross-site Fetch Metadata and a process-local anti-CSRF token. It accepts only specific asset/job routes, validates UUIDs and body sizes, and does not accept arbitrary proxy destinations. Signed URLs are retained server-side and restricted to HTTPS on `storage.googleapis.com` in the pilot's media bucket; redirects are not followed. Uploads stream rather than buffering whole videos. The UI renders model output with `textContent`, not HTML, and uses a restrictive content-security policy without third-party scripts, fonts, or analytics.

This is for a trusted local machine/account. The bridge is not multi-tenant, and any local process with the same user privileges can access local services. Do not publish it as a way around organization access policy.

## Verification

```bash
.venv/bin/pytest -q
.venv/bin/ruff check services/cloud services/inference/src/model.py scripts
node --check apps/playground/app.js
```

Tests cover the upload → job → result path using fake cloud adapters, idempotency-key forwarding, paused uploads, input bounds, signed-URL restrictions, credential separation and cross-origin/Host/session rejection. Browser checks against the real private API verified connected/paused status, a local ten-second sample preview and retrieval of the actual earlier Molmo result. No new GPU analysis was run during interface development; live upload/inference through the UI is still to be exercised during an authorized resumed session.
