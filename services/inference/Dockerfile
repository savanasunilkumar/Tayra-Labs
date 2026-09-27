FROM runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MODEL_ID=allenai/Molmo2-4B \
    MODEL_REVISION=042abfa7a38879a376cec03d949eff0aefaa0600 \
    HF_HOME=/runpod-volume/huggingface-cache \
    RUNPOD_INIT_TIMEOUT=900 \
    MAX_DOWNLOAD_BYTES=524288000 \
    MAX_VIDEO_SECONDS=300 \
    MAX_VIDEO_PIXELS=8294400 \
    MAX_VIDEO_DIMENSION=4096 \
    MAX_VIDEO_FPS=120

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN python3 -m pip install --no-cache-dir -r requirements.txt

COPY src ./src

CMD ["python3", "-u", "-m", "src.handler"]
