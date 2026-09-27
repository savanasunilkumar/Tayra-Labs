# Tayra Labs accounts

## Implemented

- Email/password signup, login, email verification, password recovery, and Google popup login (provider-gated).
- Firebase browser SDK uses in-memory persistence. After a recent, verified login, Next exchanges the ID token for a five-day Firebase Admin session cookie. Only the cookie is persisted: HttpOnly, SameSite=Lax, Secure on HTTPS. No passwords, refresh tokens, pilot keys, or service credentials are stored in browser storage.
- Every protected server page and workspace API request checks the session against the Python backend. Firebase Admin verifies the signature, project audience, expiration, disabled-user state and revocation. Unverified email cannot create a session or access media/jobs.
- Personal workspace ID is derived from the verified UID, never a client-supplied tenant or email. Uploads, completion, upload tickets, jobs, results, cancellation, deletion and history enforce ownership. Other users receive 404 for another account's resources.
- Profile display names are persisted in Firestore; account email and verification status come from Google. Names cannot change UID, email, roles or workspace ownership. Settings supports profile changes, password reset, and global session revocation. The sidebar shows the current account and offers logout.
- Browser mutations require an exact configured Origin and custom request header. JSON bodies and streamed media/results are bounded. The server-to-storage proxy only accepts exact owner-scoped objects in the configured bucket. New-account history/recovery caches are UID-scoped; old pilot history is not migrated or exposed.
- `/api/local/*` returns 410. It cannot proxy the old shared pilot identity. `ALLOW_PILOT_KEY` is false by default; legacy operator scripts require explicit opt-in and never gain access to customer workspaces.

## Run locally

1. Install Python requirements and workspace dependencies.
2. Use Application Default Credentials authorized for **video-api-dev-509820**. Do not paste credentials into chat or commit a service-account key. `gcloud auth login` and application-default login are distinct.
   Run `gcloud auth application-default login`, then `gcloud auth application-default set-quota-project video-api-dev-509820`. Restart `pnpm dev:api` after refreshing credentials so its cached credential object is replaced.
3. Copy `apps/web/.env.example` to `.env.local` and set the **public** Firebase web API key. The current local file was configured from this project's Identity Platform client settings; it is gitignored. No Google OAuth client secret belongs in Next's public config.
4. `pnpm dev:api` starts the loopback account API at `http://127.0.0.1:8080`. This launcher explicitly targets the dedicated project and forces `ANALYSIS_ENABLED=false` and `ALLOW_PILOT_KEY=false`.
5. `pnpm dev` starts the frontend at `http://127.0.0.1:3100`. Open `/signup` or `/login`. Use this exact origin; `localhost` is a different cookie/origin scope.

The old port-3000 pilot interface is not part of the customer authentication path. No GPU is started by auth or the local API launcher.

## Google configuration

Identity Platform is enabled in `video-api-dev-509820`. Email/password, the minimum 12-character password policy, improved email privacy, and authorized local development domains (`127.0.0.1`, `localhost`) were configured. The existing Firebase hosting domains were preserved.

Google provider configuration requires a Web OAuth client in this project's Google Auth Platform. Use Tayra Labs branding and the owner's chosen support/contact email. The local JavaScript origin is `http://127.0.0.1:3100`; the redirect URI is `https://video-api-dev-509820.firebaseapp.com/__/auth/handler`. Enter the client ID/secret directly in the Google provider form. Set `TAYRA_GOOGLE_SIGN_IN=true` only after Google is enabled. OAuth apps in testing may require explicit test users; public launch requires the appropriate publishing/consent review.

## Backend endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/auth/session` | Exchange a verified, recent ID token for a session; server-to-server only |
| `GET /v1/me` | Read the verified identity and persisted profile |
| `PATCH /v1/me` | Update display name only |
| `POST /v1/auth/logout-all` | Revoke the current UID's sessions |
| `GET /v1/jobs` | Most recent 30 jobs owned by the current account |
| `POST /v1/assets/{id}/upload-url` | Owner-checked immutable upload ticket |

Backend authorization accepts `Bearer <Firebase ID token>` or `Session <Firebase session cookie>`. Next handles the session header privately. An IAM-private Cloud Run deployment additionally needs `X-Serverless-Authorization: Bearer <Google service identity>`; it is not the same token. `TAYRA_API_IAM=true` uses the frontend runtime's ADC ID-token provider, not shelling out or exposing cloud keys.

## Deployment boundary

These auth changes run locally; the existing Cloud Run deployment has **not** been rolled out. It still uses its prior private pilot authentication. Do not point the account frontend at that older API or expose the pilot bridge publicly. No IAM permissions were changed, and GPU/queue remain paused.

The account history composite index (`jobs: tenant_id ASC, created_at DESC`, collection scope) was created and confirmed READY in Firestore database `video-api`. It is currently console/CLI-managed, not imported into Terraform; do not apply a duplicate resource. The original pilot data remains untouched.

Before cloud rollout: deploy the updated API, review least-privilege Identity Platform permissions (`firebaseauth.users.get`, `firebaseauth.users.update`, `firebaseauth.sessions.create`) for its runtime identity, authorize only the frontend service as an API invoker, configure exact HTTPS app/domain origins and provider settings, and verify real email delivery and Google OAuth end-to-end. Add abuse/rate limits and production monitoring before public signup. Do not bypass the existing organization access restriction. Personal developer API keys, team membership/invites, account deletion/data-erasure policy, billing and MFA management are separate product work; no dummy implementations were added.

## Verification

`pnpm check:web`, `.venv/bin/pytest -q`, `.venv/bin/ruff check services/cloud scripts/account_api.py`, and `pnpm --filter @tayra/web build --webpack`.

The optional integration test uses the real Firebase Admin SDK and **only a demo-project local Auth emulator**:

```sh
firebase emulators:start --only auth --project demo-tayra-auth --config infra/auth-emulator.json
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 .venv/bin/pytest -q services/cloud/tests/test_auth_emulator.py
```

It verifies signup, email action codes, verified sessions, profile updates, disabled-user denial, reset-password revocation and logout-all. Its synthetic emulator user is removed at the end. Setting an auth emulator against the real Google project is explicitly rejected by the application.

References: [Firebase session cookies](https://firebase.google.com/docs/auth/admin/manage-cookies), [ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens), [Auth emulator](https://firebase.google.com/docs/emulator-suite/connect_auth), [Identity Platform Google sign-in](https://cloud.google.com/identity-platform/docs/web/google).
