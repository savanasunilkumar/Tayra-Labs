ALTER TABLE jobs ADD COLUMN result_expires_at TEXT;
ALTER TABLE jobs ADD COLUMN result_deleted_at TEXT;

CREATE INDEX jobs_result_expiry_idx
  ON jobs(status, result_expires_at, result_deleted_at);
