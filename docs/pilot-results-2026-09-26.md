# First live Molmo pilot — 2026-09-26

The private Google Cloud API completed two real video analyses using `allenai/Molmo2-8B`, revision `e28fa28597e5ec5e0cca2201dd8ab33d48bc4a1b`. This verifies the deployed upload → Firestore → Cloud Tasks → GPU → stored-result path, not production readiness or parity with Twelve Labs.

## Sample and output

Input: the first ten seconds of Allen AI's [public demonstration video](https://storage.googleapis.com/oe-training-public/demo_videos/many_penguins.mp4), re-encoded as a 360×640 H.264 MP4 without audio. Spot checks at 2, 5 and 8 seconds show icy scenery, a map with Australia and miniature maritime objects, then a penguin and its reflection.

The concise follow-up asked: “Summarize the visual sequence in this video in at most three short sentences. Be concise.” Molmo returned:

> The video begins with a view of a river flowing through a snowy landscape, accompanied by text in an Asian language. It then transitions to a map featuring Australia, Indonesia, and other regions, with a boat and two lighthouses visible. The final scene shows a penguin standing on ice, with its reflection visible beneath it.

The broad sequence matches the inspected frames. This is not a full accuracy evaluation: for example, calling the icy water a “river” was not independently established. The earlier, more verbose response included unverified details and reached its 128-token limit before finishing.

## Measurements

| Measurement | Initial request | Warm concise follow-up |
| --- | ---: | ---: |
| Video duration | 10.0 s | 10.0 s |
| Worker time | 11.270 s | 3.144 s |
| Model generation time | 6.416 s | 2.926 s |
| Output tokens | 128 (limit reached) | 67 (limit 256) |
| Peak allocated GPU memory | 37,773,841,408 bytes | 37,757,915,136 bytes |
| Worker-only cost per request | $0.009976 | $0.002783 |
| Extrapolated worker-only cost per video-hour | $3.5915 | $1.0019 |

Initial job: `a3915672-0c27-423e-93c4-2a66989bd862`. Follow-up: `8f0ddf81-43eb-4cbb-8fcd-a6cbd0c19d5f`. Both used asset `ba6cf528-fea4-46b7-9076-a3dff2710b0a`.

The first client's upload-to-result wall time was 47.2 seconds, including a temporary Cloud Tasks IAM rejection followed by an automatic successful retry. The intended invoker binding was verified; no authentication restriction was weakened. Replaying the first submission with its original Idempotency-Key returned the same succeeded job with `replayed: true`, without new inference.

Worker time is not total user-facing latency. The initial GPU revision took approximately 11m20s to deploy, including a 2m06s image import. Application startup was approximately nine minutes, with the checkpoint loader reporting 8m46s. Warm results do not include this cold-start delay or cost.

## Cost and pricing caveat

Configuration: one non-zonal RTX PRO 6000, 20 vCPU and 80 GiB RAM in `us-central1`. Using [Google's on-demand instance-based prices](https://cloud.google.com/run/pricing), the combined rate is:

`($0.00036522 GPU + 20 × $0.000018 CPU + 80 × $0.000002 RAM) × 3600 = $3.186792/hour`

Worker-only cost per video-hour is `hourly instance rate × worker seconds / video seconds`. It excludes startup, idle time, builds, storage, API/queue/database usage, failures, fees and support. No credits or free tiers are deducted.

At the proposed $1.49/video-hour retail price, a 45% gross margin requires fully loaded cost no greater than $0.8195/video-hour. Even the warm short-clip result exceeds that ceiling: its worker-only implied margin is approximately 32.8%, before other costs. **The 45% target is not achieved by this test.** Different video lengths, prompts, output sizes, batching and utilization can change the result; this ten-second sample must not be treated as a representative one-hour benchmark. Customer billing remains unimplemented and pricing is provisional.

The entire deployment-start-to-observed-zero window (21:11:44–21:29:00 UTC) gives a conservative single-instance compute estimate of about $0.92. Including the short builds, CPU staging and initial storage/operations, the pilot is roughly a $1–2 test before credits, **not a verified invoice or hard spending cap**. Actual billing may lag. Retained checkpoint/image storage and the CPU API/maintenance services can continue to incur small costs after the GPU is off.

## Shutdown and access verification

- Queue `video-api-analysis` is PAUSED.
- GPU service scaling is MANUAL with `manualInstanceCount: 0`, reconciled at 21:27:51 UTC.
- Cloud Monitoring reports both active and idle GPU-service instance counts of zero at 21:29:00 UTC.
- The local pause watchdog exited successfully; it is not left running to interrupt a future test.
- Terraform retains the GPU service with `gpu_paused = true`. The API reports `analysis_enabled: false`, and saved succeeded jobs/results remain accessible.
- API and GPU are IAM-private. An organization restriction blocked public invocation; no policy was bypassed. The application API key is additionally required on customer endpoints.
- Source/result retention continues normally: 24-hour source cleanup and 30-day results, with bucket-lifecycle backstops. The analysis sample is public demonstration material, not user-provided private footage.

Next gates are cold-start/cost optimization, representative longer-video and quality benchmarks, customer credentials/quotas/billing, a developer UI, and an organization-approved public access configuration. The product name is still a working name.
