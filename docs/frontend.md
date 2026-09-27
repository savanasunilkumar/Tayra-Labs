# Tayra Labs product frontend

> Authentication update (2026-09-26): the account-aware frontend now uses `pnpm dev:api` on port 8080, Google Identity Platform, protected pages, and `/api/workspace/*`. `/api/local/*` is retired (410). See [current authentication setup](authentication.md), which supersedes the legacy adapter/profile/history instructions below. The existing visual system is retained.

The active frontend is `apps/web`, a Next.js App Router application with TypeScript, React, Tailwind CSS and real shadcn/ui components generated from the official registry. Its design is based on direct inspection of the user's authenticated Linear and Twelve Labs interfaces: an inset dark content surface, compact monochrome navigation, flat lists, and a video/prompt column beside the analysis response. It uses the supplied Tayra mark, not copied reference-product assets. See [reference review](design-reference-2026-09-26.md).

The shell now uses the official shadcn Sidebar/SidebarInset, SidebarMenuButton, Avatar, DropdownMenu, mobile Sheet and Command components. Tables, inputs, selects, buttons, tabs and dialogs also use shadcn primitives. Interface icons are imported directly from `lucide-react`; the hand-drawn Glyph component was removed. Tayra Labs is branding only at the top. The profile menu sits below Settings in the sidebar footer. Profile identity is not fabricated: account details remain unavailable until customer authentication is connected.

## Run locally

```bash
pnpm install
# Terminal 1, unless the adapter is already running:
pnpm playground
# Terminal 2:
pnpm dev
```

Frontend: http://127.0.0.1:3100. Local Python adapter: http://127.0.0.1:3000. Both bind to loopback only. The fixed host/port checks are intentional security boundaries, not configurable public hosting settings. The old HTML interface remains available on the adapter's root path during migration.

If an execution sandbox prevents file watching (EMFILE/restart loop), run the preview with approved local process permissions. Do not change filesystem ownership or disable security boundaries. A production build can also be served locally with `pnpm --filter @tayra/web start` after `pnpm build:web`; this does not constitute a public deployment.

## Implemented routes

- `/overview` (also the root destination): flat history list, search and status filters, existing job/result dialog with polling for in-progress jobs. Only actual user analyses are listed; reference examples are not automatically seeded or counted.
- `/analyze`: split-screen video selection, preview, prompt templates, advanced parameters, upload and job creation, idempotent retry, polling, cancellation, real response text, JSON/copy/download. A reference example is opened explicitly.
- `/models`: Elanus family, first release **Elanus 1 · 8B**, API ID `elanus-1-8b`, supported limits and upstream checkpoint provenance.
- `/access`: current authentication boundaries; no fake key generation or key exposure.
- `/reference`: endpoint-specific cURL examples for the existing API, with placeholder credentials and upload workflow.
- `/settings`: connection, infrastructure and retention details, with a read-only connection check. Diagnostics are confined here, with service-unavailability feedback also shown next to the Analyze action after selecting a video.
- Legacy routes `/analyses` and `/activity` redirect to `/overview`; `/playground` redirects to `/analyze`.
- Command menu: Cmd/Ctrl+K, page search, keyboard navigation; responsive sidebar.

## API integration and security

`/api/local/[...path]` is a Node route handler with a fixed destination, `http://127.0.0.1:3000`. It checks Host, Origin, Fetch Metadata and an application request header; allowlists exact route shapes/methods; streams registered uploads; forwards only the required token/content/idempotency headers; never forwards arbitrary browser authorization or destinations; preserves status codes; returns sanitized errors; disables response caching.

The Python adapter still owns the Google authentication and Secret Manager access, validates upload registration and byte counts, bounds JSON input, restricts signed storage URLs, and communicates only with project `video-api-dev-509820`. Google tokens and pilot API keys never enter Next.js client components, localStorage, snippets or screenshots. No infrastructure lifecycle endpoints exist here.

API health refreshes every 60 seconds while visible and when returning to the tab. It indicates whether the API accepts new analysis, not that a GPU is warm. Both UI and adapter block new upload registration while analysis is disabled. Reads of existing results do not trigger inference.

History records job IDs, filenames, last-known statuses and metrics in browser storage, capped at 30. An ambiguous job submission preserves its exact body/idempotency key in tab session storage. Navigating away from active polling does not cancel a cloud job: reopen it from Overview. Counts reflect visible known jobs, not account-wide usage or invoices. The reference example is an actual completed job; it can expire normally. Previously stored example entries remain preserved in storage but are excluded from the list. History in the old port-3000 origin is not silently migrated to port 3100.

## Verification

```bash
pnpm check:web
pnpm build:web
# Supported fallback if the sandbox denies Turbopack's temporary worker socket:
pnpm --filter @tayra/web build --webpack
.venv/bin/pytest -q
.venv/bin/ruff check services/cloud services/inference/src/model.py scripts
```

Tests cover route/method allowlisting, hostile origin/host rejection, header isolation, idempotency forwarding, streamed uploads, length checks, empty responses, sanitized failures, file validation, history search/status filtering, and non-destructive example separation. Backend tests continue to verify the full mocked upload → job → result flow. Browser verification covers desktop and mobile layouts, mobile navigation, prompt selection, local video preview, and real saved text/JSON output without new GPU inference. Live inference through the new UI requires a separately authorized compute session.

Typography and model identity update: Inter is self-hosted from `@fontsource-variable/inter` through `next/font/local`, with a preloaded local WOFF2. The global `font: inherit` override was removed, so shadcn controls retain their intended size and weight. CTA links use Button `asChild`; Overview filters use ToggleGroup; advanced settings and model/response details use Collapsible with Button triggers. Native details/summary controls and custom button-lookalike styles were removed. Tailwind base resets no longer override component utilities. Sidebar brand and bottom profile placement are preserved.

Latest verification: 16 frontend tests and 58 backend tests passed, plus TypeScript, Prettier and Ruff. Tests include public model naming, alias validation, unknown-model rejection, checkpoint preservation and idempotent compatibility. The production Webpack build passed. Browser checks covered 1440px desktop and 390px mobile layouts, token and prompt dropdowns, status filters, mobile navigation, model provenance and the served local WOFF2 font (HTTP 200). Webpack is the supported fallback when this execution sandbox blocks Turbopack's temporary worker socket. No new inference was submitted.

## Remaining product work

This is the product UI foundation, not a claim that the API is publicly launch-ready. Next steps are customer sign-in, tenant ownership enforcement, scoped/revocable API keys, account-wide activity/usage, quotas and billing, plus an approved deployment/security design. The current local adapter must not be published or tunneled as a way around Google organization access restrictions. No IAM, Terraform, deployed service configuration or GPU scaling changes are part of this frontend migration.

References: [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [shadcn/ui Next.js setup](https://ui.shadcn.com/docs/installation/next), [shadcn Sidebar](https://ui.shadcn.com/docs/components/radix/sidebar), [shadcn Command](https://ui.shadcn.com/docs/components/radix/command), [Linear visual reference](https://linear.app/features).
