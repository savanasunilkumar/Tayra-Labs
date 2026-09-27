import { timingSafeEqual } from "node:crypto";

const MAX_JSON_BYTES = 32 * 1024;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function jsonResponse(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

export function withCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get("origin");
  if (origin && origin === env.ALLOWED_ORIGIN) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("vary", "Origin");
  }
  response.headers.set("access-control-allow-headers", "authorization, content-type, idempotency-key");
  response.headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  return response;
}

export async function parseBoundedJson(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new ApiError(413, "request_too_large", "JSON request body is too large");
  }
  if (!request.body) {
    throw new ApiError(400, "invalid_json", "A JSON request body is required");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new ApiError(413, "request_too_large", "JSON request body is too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new ApiError(400, "invalid_json", "Request body must be a JSON object");
  }
  return parsed;
}

export async function requireApiKey(request: Request, env: Env): Promise<void> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new ApiError(401, "unauthorized", "A bearer API key is required");
  }
  const provided = authorization.slice("Bearer ".length);
  if (!(await constantTimeTextEqual(provided, env.INQOX_API_KEY))) {
    throw new ApiError(401, "unauthorized", "The API key is invalid");
  }
}

export async function constantTimeTextEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return timingSafeEqual(new Uint8Array(aHash), new Uint8Array(bHash));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getRequiredString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new ApiError(400, "invalid_request", `${key} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

export function getInteger(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = record[key] ?? fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ApiError(400, "invalid_request", `${key} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}
