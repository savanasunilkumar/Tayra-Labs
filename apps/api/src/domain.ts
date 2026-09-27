export type AssetStatus = "pending_upload" | "ready" | "rejected" | "deleted" | "expired";
export type JobStatus =
  | "submitting"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancel_requested"
  | "cancelled";

export interface AssetRow {
  id: string;
  object_key: string;
  filename: string;
  content_type: string;
  expected_bytes: number;
  actual_bytes: number | null;
  status: AssetStatus;
  created_at: string;
  updated_at: string;
  retention_until: string;
}

export interface JobRow {
  id: string;
  asset_id: string;
  mode: "standard";
  prompt: string;
  max_new_tokens: number;
  model_id: string;
  status: JobStatus;
  idempotency_key: string;
  request_hash: string;
  runpod_job_id: string | null;
  callback_token_hash: string;
  result_key: string;
  queue_time_ms: number | null;
  execution_time_ms: number | null;
  output_tokens: number | null;
  error_code: string | null;
  error_message: string | null;
  result_expires_at: string | null;
  result_deleted_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface RunpodStatusResponse {
  id: string;
  status: string;
  delayTime?: number;
  executionTime?: number;
  output?: unknown;
  error?: unknown;
}

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);
