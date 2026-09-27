FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
WORKDIR /app
COPY services/cloud/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY services/cloud /app/services/cloud
CMD ["sh", "-c", "exec uvicorn services.cloud.api:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --no-access-log"]
