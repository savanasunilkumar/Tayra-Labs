import type { AssetRow, JobRow, JobStatus, RunpodStatusResponse } from "./domain";
import { TERMINAL_JOB_STATUSES } from "./domain";
import {
  ApiError,
  constantTimeTextEqual,
  getInteger,
  getRequiredString,
  isRecord,
  jsonResponse,
  parseBoundedJson,
  randomToken,
  requireApiKey,
  sha256Hex,
  withCors,
} from "./http";
import { signR2ObjectUrl } from "./r2";
import { cancelRunpodJob, getRunpodStatus, submitRunpodJob } from "./runpod";

const VIDEO_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
});

function envInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function publicAsset(asset: AssetRow): Record<string, unknown> {
  return {
    id: asset.id,
    filename: asset.filename,
    content_type: asset.content_type,
    expected_bytes: asset.expected_bytes,
    actual_bytes: asset.actual_bytes,
    status: asset.status,
    created_at: asset.created_at,
    retention_until: asset.retention_until,
  };
}

function publicJob(job: JobRow): Record<string, unknown> {
  return {
    id: job.id,
    asset_id: job.asset_id,
    mode: job.mode,
    model: job.model_id,
    status: job.status,
    queue_time_ms: job.queue_time_ms,
    execution_time_ms: job.execution_time_ms,
    output_tokens: job.output_tokens,
    error:
      job.error_code === null
        ? null
        : { code: job.error_code, message: job.error_message ?? "The analysis job failed" },
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
    result_expires_at: job.result_expires_at,
  };
}

async function loadAsset(env: Env, assetId: string): Promise<AssetRow> {
  const asset = await env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(assetId).first<AssetRow>();
  if (!asset || asset.status === "deleted") {
    throw new ApiError(404, "asset_not_found", "Asset not found");
  }
  return asset;
}

async function loadJob(env: Env, jobId: string): Promise<JobRow> {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<JobRow>();
  if (!job) throw new ApiError(404, "job_not_found", "Job not found");
  return job;
}

async function createAsset(request: Request, env: Env): Promise<Response> {
  const body = await parseBoundedJson(request);
  const filename = getRequiredString(body, "filename", 255);
  const contentType = getRequiredString(body, "content_type", 100).toLowerCase();
  const extension = VIDEO_CONTENT_TYPES[contentType];
  if (!extension) {
    throw new ApiError(400, "unsupported_content_type", "Supported video types are MP4, MOV, and WebM");
  }
  const maxUploadBytes = envInteger(env.MAX_UPLOAD_BYTES, "MAX_UPLOAD_BYTES");
  const sizeBytes = getInteger(body, "size_bytes", 0, 1, maxUploadBytes);
  const assetId = crypto.randomUUID();
  const objectKey = `source/default/${assetId}/original.${extension}`;
  const now = new Date();
  const retentionUntil = new Date(
    now.getTime() + envInteger(env.SOURCE_RETENTION_HOURS, "SOURCE_RETENTION_HOURS") * 3_600_000,
  ).toISOString();

  await env.DB.prepare(
    `INSERT INTO assets
      (id, object_key, filename, content_type, expected_bytes, actual_bytes, status, created_at, updated_at, retention_until)
     VALUES (?, ?, ?, ?, ?, NULL, 'pending_upload', ?, ?, ?)`,
  )
    .bind(assetId, objectKey, filename, contentType, sizeBytes, now.toISOString(), now.toISOString(), retentionUntil)
    .run();

  const expiresIn = envInteger(env.UPLOAD_URL_TTL_SECONDS, "UPLOAD_URL_TTL_SECONDS");
  const uploadUrl = await signR2ObjectUrl(env, objectKey, "PUT", expiresIn, contentType);
  return jsonResponse(
    {
      asset: {
        id: assetId,
        filename,
        content_type: contentType,
        expected_bytes: sizeBytes,
        status: "pending_upload",
        created_at: now.toISOString(),
        retention_until: retentionUntil,
      },
      upload: {
        method: "PUT",
        url: uploadUrl,
        headers: { "content-type": contentType },
        expires_in_seconds: expiresIn,
      },
    },
    201,
  );
}

async function completeAsset(env: Env, assetId: string): Promise<Response> {
  const asset = await loadAsset(env, assetId);
  if (asset.status === "ready") return jsonResponse({ asset: publicAsset(asset), replayed: true });
  if (asset.status !== "pending_upload") {
    throw new ApiError(409, "invalid_asset_state", `Asset cannot be completed from ${asset.status}`);
  }
  if (asset.retention_until <= new Date().toISOString()) {
    throw new ApiError(410, "asset_expired", "The upload registration has expired");
  }

  const object = await env.MEDIA.head(asset.object_key);
  if (!object) throw new ApiError(409, "upload_missing", "The uploaded object was not found");
  if (object.size !== asset.expected_bytes) {
    await env.DB.prepare(
      "UPDATE assets SET status = 'rejected', actual_bytes = ?, updated_at = ? WHERE id = ? AND status = 'pending_upload'",
    )
      .bind(object.size, new Date().toISOString(), asset.id)
      .run();
    throw new ApiError(409, "upload_size_mismatch", "Uploaded object size does not match the declared size");
  }
  const uploadedContentType = object.httpMetadata?.contentType?.toLowerCase();
  if (uploadedContentType && uploadedContentType !== asset.content_type) {
    await env.DB.prepare(
      "UPDATE assets SET status = 'rejected', actual_bytes = ?, updated_at = ? WHERE id = ? AND status = 'pending_upload'",
    )
      .bind(object.size, new Date().toISOString(), asset.id)
      .run();
    throw new ApiError(409, "upload_type_mismatch", "Uploaded object type does not match the declared type");
  }

  const updatedAt = new Date().toISOString();
  const completed = await env.DB.prepare(
    `UPDATE assets SET status = 'ready', actual_bytes = ?, updated_at = ?
     WHERE id = ? AND status = 'pending_upload' AND retention_until > ?`,
  )
    .bind(object.size, updatedAt, asset.id, updatedAt)
    .run();
  if (completed.meta.changes !== 1) {
    throw new ApiError(409, "asset_not_ready", "The upload expired or was deleted while it was being completed");
  }
  return jsonResponse({
    asset: publicAsset({ ...asset, status: "ready", actual_bytes: object.size, updated_at: updatedAt }),
  });
}

async function deleteAsset(env: Env, assetId: string): Promise<Response> {
  const asset = await loadAsset(env, assetId);
  const now = new Date().toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE assets SET status = 'expired', updated_at = ?
     WHERE id = ? AND status IN ('pending_upload', 'ready', 'rejected', 'expired')
       AND NOT EXISTS (
         SELECT 1 FROM jobs
         WHERE asset_id = ? AND status IN ('submitting', 'queued', 'running', 'cancel_requested')
       )`,
  )
    .bind(now, asset.id, asset.id)
    .run();
  if (claimed.meta.changes === 0) {
    throw new ApiError(409, "asset_in_use", "Asset has an active analysis job");
  }

  await env.MEDIA.delete(asset.object_key);
  await env.DB.prepare("UPDATE assets SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'expired'")
    .bind(new Date().toISOString(), asset.id)
    .run();
  return new Response(null, { status: 204 });
}

async function persistRunpodSubmission(
  env: Env,
  jobId: string,
  submission: { id: string; status: string },
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE jobs
     SET status = CASE WHEN status = 'cancel_requested' THEN status ELSE 'queued' END,
         runpod_job_id = ?, updated_at = ?
     WHERE id = ? AND status IN ('submitting', 'cancel_requested')`,
  )
    .bind(submission.id, updatedAt, jobId)
    .run();
  if (result.meta.changes === 1) return;

  const current = await loadJob(env, jobId);
  if (current.runpod_job_id !== submission.id) {
    throw new Error("RunPod submission could not be attached to its local job");
  }
}

async function createJob(request: Request, env: Env, origin: string): Promise<Response> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "Idempotency-Key is required and must be at most 128 characters");
  }
  const body = await parseBoundedJson(request);
  const assetId = getRequiredString(body, "asset_id", 100);
  const prompt = getRequiredString(body, "prompt", 4000);
  const modeValue = body.mode ?? "standard";
  if (modeValue !== "standard") {
    throw new ApiError(400, "unsupported_mode", "Only standard analysis is enabled in the MVP");
  }
  const maxNewTokens = getInteger(body, "max_new_tokens", 512, 1, 2048);
  const requestHash = await sha256Hex(JSON.stringify({ asset_id: assetId, prompt, mode: "standard", max_new_tokens: maxNewTokens }));

  const prior = await env.DB.prepare("SELECT * FROM jobs WHERE idempotency_key = ?")
    .bind(idempotencyKey)
    .first<JobRow>();
  if (prior) {
    if (prior.request_hash !== requestHash) {
      throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was used with a different request");
    }
    return jsonResponse({ job: publicJob(prior), replayed: true });
  }

  const asset = await loadAsset(env, assetId);
  if (asset.status !== "ready") {
    throw new ApiError(409, "asset_not_ready", "Complete the asset upload before creating a job");
  }

  const jobId = crypto.randomUUID();
  const callbackToken = randomToken();
  const callbackTokenHash = await sha256Hex(callbackToken);
  const resultKey = `result/default/${jobId}/result.json`;
  const now = new Date().toISOString();
  if (asset.retention_until <= now) {
    throw new ApiError(410, "asset_expired", "The source asset has expired");
  }
  const inserted = await env.DB.prepare(
    `INSERT INTO jobs
      (id, asset_id, mode, prompt, max_new_tokens, model_id, status, idempotency_key, request_hash,
       runpod_job_id, callback_token_hash, result_key, created_at, updated_at)
     SELECT ?, ?, 'standard', ?, ?, ?, 'submitting', ?, ?, NULL, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM assets WHERE id = ? AND status = 'ready' AND retention_until > ?
     )`,
  )
    .bind(
      jobId,
      asset.id,
      prompt,
      maxNewTokens,
      env.MODEL_ID,
      idempotencyKey,
      requestHash,
      callbackTokenHash,
      resultKey,
      now,
      now,
      asset.id,
      now,
    )
    .run();
  if (inserted.meta.changes !== 1) {
    throw new ApiError(409, "asset_not_ready", "The source asset is no longer available for analysis");
  }

  let submission: { id: string; status: string };
  try {
    const jobUrlTtl = envInteger(env.SOURCE_URL_TTL_SECONDS, "SOURCE_URL_TTL_SECONDS");
    const [videoUrl, resultPutUrl] = await Promise.all([
      signR2ObjectUrl(env, asset.object_key, "GET", jobUrlTtl),
      signR2ObjectUrl(env, resultKey, "PUT", jobUrlTtl, "application/json"),
    ]);
    const webhook = `${origin}/internal/runpod/callback/${encodeURIComponent(jobId)}/${encodeURIComponent(callbackToken)}`;
    submission = await submitRunpodJob(
      env,
      {
        job_id: jobId,
        video_url: videoUrl,
        result_put_url: resultPutUrl,
        prompt,
        mode: "standard",
        model_id: env.MODEL_ID,
        model_revision: env.MODEL_REVISION,
        max_new_tokens: maxNewTokens,
        max_download_bytes: envInteger(env.MAX_UPLOAD_BYTES, "MAX_UPLOAD_BYTES"),
        expected_bytes: asset.actual_bytes ?? asset.expected_bytes,
      },
      webhook,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "RunPod submission failed";
    const failedAt = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE jobs SET status = 'failed', error_code = 'submission_failed', error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?",
    )
      .bind(message, failedAt, failedAt, jobId)
      .run();
    throw error;
  }

  try {
    await persistRunpodSubmission(env, jobId, submission);
  } catch (error) {
    try {
      await persistRunpodSubmission(env, jobId, submission);
    } catch (retryError) {
      let cancellationStatus: string | null = null;
      try {
        cancellationStatus = (await cancelRunpodJob(env, submission.id)).status;
      } catch (cancelError) {
        console.error(
          JSON.stringify({
            message: "untracked RunPod submission cancellation failed",
            job_id: jobId,
            runpod_job_id: submission.id,
            error: cancelError instanceof Error ? cancelError.message : String(cancelError),
          }),
        );
      }
      try {
        const failedAt = new Date().toISOString();
        const cancelled = runpodStatusToJobStatus(cancellationStatus ?? "") === "cancelled";
        await env.DB.prepare(
          `UPDATE jobs
           SET status = ?, runpod_job_id = ?, error_code = 'submission_tracking_failed', error_message = ?,
               updated_at = ?, completed_at = ?
           WHERE id = ? AND status = 'submitting'`,
        )
          .bind(
            cancelled ? "cancelled" : "submitting",
            submission.id,
            (retryError instanceof Error ? retryError.message : String(retryError)).slice(0, 1000),
            failedAt,
            cancelled ? failedAt : null,
            jobId,
          )
          .run();
      } catch (recoveryError) {
        console.error(
          JSON.stringify({
            message: "RunPod submission recovery state could not be saved",
            job_id: jobId,
            runpod_job_id: submission.id,
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          }),
        );
      }
      throw new ApiError(503, "submission_tracking_failed", "The analysis job could not be safely tracked; retry with the same Idempotency-Key");
    }
  }

  const trackedAt = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO job_attempts (job_id, runpod_job_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(jobId, submission.id, submission.status, trackedAt, trackedAt)
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "job attempt audit row could not be recorded",
        job_id: jobId,
        runpod_job_id: submission.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  let created = await loadJob(env, jobId);
  if (created.status === "cancel_requested") {
    await cancelRunpodJob(env, submission.id);
    created = await reconcileJob(env, created);
  }
  return jsonResponse({ job: publicJob(created) }, 202);
}

function runpodStatusToJobStatus(status: string): JobStatus | null {
  switch (status.toUpperCase()) {
    case "IN_QUEUE":
      return "queued";
    case "IN_PROGRESS":
    case "RUNNING":
      return "running";
    case "COMPLETED":
      return "succeeded";
    case "FAILED":
    case "ERROR":
      return "failed";
    case "TIMED_OUT":
      return "timed_out";
    case "CANCELLED":
    case "CANCELED":
      return "cancelled";
    default:
      return null;
  }
}

function outputTokens(status: RunpodStatusResponse): number | null {
  if (!isRecord(status.output)) return null;
  if (typeof status.output.output_tokens === "number") return Math.max(0, Math.trunc(status.output.output_tokens));
  const metrics = status.output.metrics;
  if (isRecord(metrics) && typeof metrics.output_tokens === "number") {
    return Math.max(0, Math.trunc(metrics.output_tokens));
  }
  return null;
}

function runpodErrorMessage(status: RunpodStatusResponse): string | null {
  if (status.error === undefined) return null;
  if (typeof status.error === "string") return status.error.slice(0, 1000);
  try {
    return JSON.stringify(status.error).slice(0, 1000);
  } catch {
    return "RunPod job failed";
  }
}

async function reconcileJob(env: Env, job: JobRow): Promise<JobRow> {
  if (!job.runpod_job_id || TERMINAL_JOB_STATUSES.has(job.status)) return job;
  const remote = await getRunpodStatus(env, job.runpod_job_id);
  let nextStatus = runpodStatusToJobStatus(remote.status);
  if (!nextStatus) return job;

  let errorCode: string | null = null;
  let errorMessage = runpodErrorMessage(remote);
  if (nextStatus === "succeeded") {
    const result = await env.MEDIA.head(job.result_key);
    if (!result) {
      nextStatus = "failed";
      errorCode = "result_missing";
      errorMessage = "RunPod completed without writing the result object";
    }
  } else if (nextStatus === "failed" || nextStatus === "timed_out") {
    errorCode = nextStatus === "timed_out" ? "runpod_timeout" : "runpod_failed";
  }

  const now = new Date().toISOString();
  const completedAt = TERMINAL_JOB_STATUSES.has(nextStatus) ? now : null;
  const resultExpiresAt =
    nextStatus === "succeeded"
      ? new Date(
          Date.now() + envInteger(env.RESULT_RETENTION_DAYS, "RESULT_RETENTION_DAYS") * 86_400_000,
        ).toISOString()
      : null;
  const tokens = outputTokens(remote);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs
       SET status = ?, queue_time_ms = COALESCE(?, queue_time_ms), execution_time_ms = COALESCE(?, execution_time_ms),
           output_tokens = COALESCE(?, output_tokens), error_code = ?, error_message = ?, updated_at = ?,
           completed_at = COALESCE(?, completed_at), result_expires_at = COALESCE(?, result_expires_at)
       WHERE id = ?
         AND status NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled')
         AND NOT (status = 'cancel_requested' AND ? IN ('queued', 'running'))`,
    ).bind(
      nextStatus,
      remote.delayTime ?? null,
      remote.executionTime ?? null,
      tokens,
      errorCode,
      errorMessage,
      now,
      completedAt,
      resultExpiresAt,
      job.id,
      nextStatus,
    ),
    env.DB.prepare(
      `UPDATE job_attempts
       SET status = ?, queue_time_ms = COALESCE(?, queue_time_ms), execution_time_ms = COALESCE(?, execution_time_ms),
           error_message = ?, updated_at = ?
       WHERE job_id = ? AND runpod_job_id = ?`,
    ).bind(
      remote.status,
      remote.delayTime ?? null,
      remote.executionTime ?? null,
      errorMessage,
      now,
      job.id,
      job.runpod_job_id,
    ),
  ]);
  return loadJob(env, job.id);
}

async function jobResult(env: Env, jobId: string): Promise<Response> {
  const job = await loadJob(env, jobId);
  if (job.status !== "succeeded") {
    throw new ApiError(409, "result_not_ready", `Result is not available while the job is ${job.status}`);
  }
  if (
    job.result_deleted_at !== null ||
    (job.result_expires_at !== null && job.result_expires_at <= new Date().toISOString())
  ) {
    if (job.result_deleted_at === null) {
      const now = new Date().toISOString();
      await env.MEDIA.delete(job.result_key);
      await env.DB.prepare("UPDATE jobs SET result_deleted_at = ?, updated_at = ? WHERE id = ?")
        .bind(now, now, job.id)
        .run();
    }
    throw new ApiError(410, "result_expired", "The result object has expired");
  }
  const result = await env.MEDIA.head(job.result_key);
  if (!result) throw new ApiError(410, "result_expired", "The result object is no longer available");
  const expiresIn = envInteger(env.RESULT_URL_TTL_SECONDS, "RESULT_URL_TTL_SECONDS");
  const url = await signR2ObjectUrl(env, job.result_key, "GET", expiresIn);
  return jsonResponse({ job_id: job.id, result_url: url, expires_in_seconds: expiresIn });
}

async function cancelJob(env: Env, jobId: string): Promise<Response> {
  const job = await loadJob(env, jobId);
  if (TERMINAL_JOB_STATUSES.has(job.status)) return jsonResponse({ job: publicJob(job), replayed: true });
  const now = new Date().toISOString();
  if (!job.runpod_job_id) {
    await env.DB.prepare(
      `UPDATE jobs SET status = 'cancel_requested', updated_at = ?
       WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled')`,
    )
      .bind(now, job.id)
      .run();
    return jsonResponse({ job: publicJob(await loadJob(env, job.id)) }, 202);
  }
  await env.DB.prepare(
    `UPDATE jobs SET status = 'cancel_requested', updated_at = ?
     WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled')`,
  )
    .bind(now, job.id)
    .run();
  const cancelRequested = await loadJob(env, job.id);
  if (TERMINAL_JOB_STATUSES.has(cancelRequested.status)) {
    return jsonResponse({ job: publicJob(cancelRequested), replayed: true });
  }
  await cancelRunpodJob(env, job.runpod_job_id);
  const updated = await reconcileJob(env, cancelRequested);
  return jsonResponse({ job: publicJob(updated) }, 202);
}

async function handleRunpodCallback(
  request: Request,
  env: Env,
  jobId: string,
  callbackToken: string,
): Promise<Response> {
  let job = await loadJob(env, jobId);
  const providedHash = await sha256Hex(callbackToken);
  if (!(await constantTimeTextEqual(providedHash, job.callback_token_hash))) {
    throw new ApiError(401, "invalid_callback", "Invalid callback token");
  }

  if (
    job.runpod_job_id === null &&
    (job.status === "submitting" ||
      job.status === "cancel_requested" ||
      (job.status === "failed" && job.error_code === "submission_failed"))
  ) {
    const callback = await parseBoundedJson(request);
    const runpodJobId = getRequiredString(callback, "id", 200);
    const recoveredAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE jobs
         SET status = CASE WHEN status = 'cancel_requested' THEN status ELSE 'queued' END,
             runpod_job_id = ?, error_code = NULL, error_message = NULL,
             completed_at = NULL, updated_at = ?
         WHERE id = ? AND runpod_job_id IS NULL
           AND (status IN ('submitting', 'cancel_requested') OR (status = 'failed' AND error_code = 'submission_failed'))`,
      ).bind(runpodJobId, recoveredAt, job.id),
      env.DB.prepare(
        "INSERT OR IGNORE INTO job_attempts (job_id, runpod_job_id, status, created_at, updated_at) VALUES (?, ?, 'WEBHOOK_RECOVERED', ?, ?)",
      ).bind(job.id, runpodJobId, recoveredAt, recoveredAt),
    ]);
    job = await loadJob(env, job.id);
    if (job.runpod_job_id !== runpodJobId) {
      throw new ApiError(409, "callback_job_mismatch", "RunPod callback job identifier does not match");
    }
  }
  if (TERMINAL_JOB_STATUSES.has(job.status)) {
    return jsonResponse({ accepted: true, status: job.status });
  }
  if (job.status === "cancel_requested" && job.runpod_job_id !== null) {
    await cancelRunpodJob(env, job.runpod_job_id);
  }
  const updated = await reconcileJob(env, job);
  return jsonResponse({ accepted: true, status: updated.status });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/u, "") || "/";

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method === "GET" && path === "/health") {
    return jsonResponse({ status: "ok", service: "inqox-api", model: env.MODEL_ID });
  }

  const callbackMatch = path.match(/^\/internal\/runpod\/callback\/([^/]+)\/([^/]+)$/u);
  if (request.method === "POST" && callbackMatch) {
    const jobId = callbackMatch[1];
    const token = callbackMatch[2];
    if (!jobId || !token) throw new ApiError(404, "not_found", "Route not found");
    return handleRunpodCallback(request, env, decodeURIComponent(jobId), decodeURIComponent(token));
  }

  if (path.startsWith("/v1/")) await requireApiKey(request, env);

  if (request.method === "POST" && path === "/v1/assets") return createAsset(request, env);

  const completeAssetMatch = path.match(/^\/v1\/assets\/([^/]+)\/complete$/u);
  if (request.method === "POST" && completeAssetMatch?.[1]) {
    return completeAsset(env, decodeURIComponent(completeAssetMatch[1]));
  }
  const assetMatch = path.match(/^\/v1\/assets\/([^/]+)$/u);
  if (request.method === "GET" && assetMatch?.[1]) {
    return jsonResponse({ asset: publicAsset(await loadAsset(env, decodeURIComponent(assetMatch[1]))) });
  }
  if (request.method === "DELETE" && assetMatch?.[1]) {
    return deleteAsset(env, decodeURIComponent(assetMatch[1]));
  }

  if (request.method === "POST" && path === "/v1/jobs") {
    return createJob(request, env, url.origin);
  }
  const resultMatch = path.match(/^\/v1\/jobs\/([^/]+)\/result$/u);
  if (request.method === "GET" && resultMatch?.[1]) {
    return jobResult(env, decodeURIComponent(resultMatch[1]));
  }
  const cancelMatch = path.match(/^\/v1\/jobs\/([^/]+)\/cancel$/u);
  if (request.method === "POST" && cancelMatch?.[1]) {
    return cancelJob(env, decodeURIComponent(cancelMatch[1]));
  }
  const jobMatch = path.match(/^\/v1\/jobs\/([^/]+)$/u);
  if (request.method === "GET" && jobMatch?.[1]) {
    let job = await loadJob(env, decodeURIComponent(jobMatch[1]));
    if (url.searchParams.get("refresh") === "true" && !TERMINAL_JOB_STATUSES.has(job.status)) {
      job = await reconcileJob(env, job);
    }
    return jsonResponse({ job: publicJob(job) });
  }

  throw new ApiError(404, "not_found", "Route not found");
}

async function reconcileStaleJobs(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 120_000).toISOString();
  const result = await env.DB.prepare(
    `SELECT * FROM jobs
     WHERE status IN ('submitting', 'queued', 'running', 'cancel_requested')
       AND runpod_job_id IS NOT NULL AND updated_at < ?
     ORDER BY updated_at ASC LIMIT 20`,
  )
    .bind(cutoff)
    .all<JobRow>();
  for (const job of result.results) {
    try {
      if (job.status === "cancel_requested" && job.runpod_job_id !== null) {
        await cancelRunpodJob(env, job.runpod_job_id);
      }
      await reconcileJob(env, job);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "job reconciliation failed",
          job_id: job.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

async function expireOrphanedSubmissions(env: Env): Promise<void> {
  const cutoff = new Date(
    Date.now() - envInteger(env.SUBMISSION_RECOVERY_SECONDS, "SUBMISSION_RECOVERY_SECONDS") * 1_000,
  ).toISOString();
  const expiredAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE jobs
     SET status = CASE WHEN status = 'cancel_requested' THEN 'cancelled' ELSE 'timed_out' END,
         error_code = CASE WHEN status = 'cancel_requested' THEN NULL ELSE 'submission_orphaned' END,
         error_message = 'RunPod never supplied a recoverable job identifier',
         updated_at = ?, completed_at = ?
     WHERE status IN ('submitting', 'cancel_requested') AND runpod_job_id IS NULL AND updated_at < ?`,
  )
    .bind(expiredAt, expiredAt, cutoff)
    .run();
}

async function cleanupExpiredSources(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `SELECT a.* FROM assets a
     WHERE a.status IN ('pending_upload', 'ready', 'rejected', 'expired')
       AND a.retention_until <= ?
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.asset_id = a.id
           AND j.status IN ('submitting', 'queued', 'running', 'cancel_requested')
       )
     ORDER BY a.retention_until ASC LIMIT 20`,
  )
    .bind(now)
    .all<AssetRow>();

  for (const asset of result.results) {
    try {
      const claimed = await env.DB.prepare(
        `UPDATE assets SET status = 'expired', updated_at = ?
         WHERE id = ? AND status IN ('pending_upload', 'ready', 'rejected', 'expired')
           AND retention_until <= ?
           AND NOT EXISTS (
             SELECT 1 FROM jobs
             WHERE asset_id = ? AND status IN ('submitting', 'queued', 'running', 'cancel_requested')
           )`,
      )
        .bind(now, asset.id, now, asset.id)
        .run();
      if (claimed.meta.changes === 0) continue;
      await env.MEDIA.delete(asset.object_key);
      await env.DB.prepare("UPDATE assets SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'expired'")
        .bind(now, asset.id)
        .run();
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "source cleanup failed",
          asset_id: asset.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

async function cleanupExpiredResults(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `SELECT * FROM jobs
     WHERE status = 'succeeded' AND result_expires_at <= ? AND result_deleted_at IS NULL
     ORDER BY result_expires_at ASC LIMIT 20`,
  )
    .bind(now)
    .all<JobRow>();

  for (const job of result.results) {
    try {
      await env.MEDIA.delete(job.result_key);
      await env.DB.prepare("UPDATE jobs SET result_deleted_at = ?, updated_at = ? WHERE id = ?")
        .bind(now, now, job.id)
        .run();
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "result cleanup failed",
          job_id: job.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

async function runScheduledMaintenance(env: Env): Promise<void> {
  await reconcileStaleJobs(env);
  await expireOrphanedSubmissions(env);
  await cleanupExpiredSources(env);
  await cleanupExpiredResults(env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const response = await route(request, env);
      response.headers.set("x-request-id", requestId);
      return withCors(response, request, env);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, "internal_error", "Internal server error");
      const pathname = new URL(request.url).pathname;
      const safePath = pathname.startsWith("/internal/runpod/callback/")
        ? "/internal/runpod/callback/[redacted]"
        : pathname;
      console.error(
        JSON.stringify({
          message: "request failed",
          request_id: requestId,
          method: request.method,
          path: safePath,
          code: apiError.code,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      const response = jsonResponse(
        { error: { code: apiError.code, message: apiError.message }, request_id: requestId },
        apiError.status,
      );
      response.headers.set("x-request-id", requestId);
      return withCors(response, request, env);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env>;
