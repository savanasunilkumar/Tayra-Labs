# Tayra Labs brand decisions

Confirmed by the founder on September 26, 2026:

- Company name: **Tayra Labs**.
- Logo: the supplied monochrome tayra SVG, preserved unchanged at `apps/playground/tayra-logo.svg`.
- Model family: **Elanus**.
- First release: **Elanus 1 · 8B**.
- Public API model ID: **`elanus-1-8b`**.
- Elanus names Tayra’s served release. Do not describe it as a proprietary Tayra-trained base model.
- Current underlying model: `allenai/Molmo2-8B`, with its pinned revision unchanged. Keep this provenance visible in technical details and responses.

The Next.js workspace uses the release name across Analyze, Models, Settings and response details. It loads a self-hosted Inter variable font through `next/font/local`. The logo is also preserved at `apps/web/public/tayra-logo.svg`. Historical result JSON is not rewritten.

Internal identifiers are not company branding. Keep Google project `video-api-dev-509820`, resource prefix `video-api`, URLs, upstream checkpoint IDs and secret names stable. The public alias is separate from the Hugging Face download ID. The local adapter validates the alias and translates it to the existing single-model cloud request. Cloud API source accepts an optional `model` field and emits the public alias separately from checkpoint provenance; deploying those additions remains a separate step. This update does not modify Terraform, deploy cloud services, resume GPUs or change IAM.

Earlier reports are historical records; they may contain Inqox or Video API working names. This document records the current company identity, not trademark or domain availability verification.
