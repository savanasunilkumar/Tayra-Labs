# Shared Molmo runtime

The active Google deployment uses `Dockerfile.google` (build context: repository root), `services.cloud.worker`, and `allenai/Molmo2-8B` pinned in `services/cloud/config.py`.

It loads the snapshot from a read-only Cloud Storage mount, checks its completion manifest, validates video with ffprobe and performs standard visual analysis. The initial GPU configuration is a 96 GB RTX PRO 6000; actual fit, latency and cost are not yet benchmarked.

```bash
docker build --platform linux/amd64 -f services/inference/Dockerfile.google -t video-api-worker:local .
```

The original `Dockerfile`, `requirements.txt`, `.env.example`, `src/handler.py` and RunPod-specific contracts are retained as legacy reference. They still name the former 4B default and must not be used to deploy the current Google product.

Run CPU-only validation tests from the repository root:

```bash
.venv/bin/pytest -q
```

A real GPU smoke test is still mandatory. Record video duration, generation time, worker time, output tokens, allocated VRAM, cold-start latency and total billed instance time. See [Google setup](../../docs/setup.md).
