PRAGMA foreign_keys = ON;

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes > 0),
  actual_bytes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending_upload', 'ready', 'rejected', 'deleted', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retention_until TEXT NOT NULL
);

CREATE INDEX assets_status_created_idx ON assets(status, created_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  mode TEXT NOT NULL CHECK (mode IN ('standard')),
  prompt TEXT NOT NULL,
  max_new_tokens INTEGER NOT NULL CHECK (max_new_tokens BETWEEN 1 AND 2048),
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitting', 'queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancel_requested', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  runpod_job_id TEXT UNIQUE,
  callback_token_hash TEXT NOT NULL,
  result_key TEXT NOT NULL UNIQUE,
  queue_time_ms INTEGER,
  execution_time_ms INTEGER,
  output_tokens INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX jobs_status_updated_idx ON jobs(status, updated_at);
CREATE INDEX jobs_asset_idx ON jobs(asset_id, created_at);

CREATE TABLE job_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  runpod_job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  queue_time_ms INTEGER,
  execution_time_ms INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, runpod_job_id)
);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('reserved', 'finalized', 'voided')),
  video_seconds REAL,
  gpu_milliseconds INTEGER,
  output_tokens INTEGER,
  estimated_cogs_usd REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX usage_events_job_idx ON usage_events(job_id, created_at);

