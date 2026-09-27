import { ApiError, isRecord } from "./http";
import type { RunpodStatusResponse } from "./domain";

const RUNPOD_BASE_URL = "https://api.runpod.ai/v2";

function endpointUrl(env: Env, path: string): string {
  return `${RUNPOD_BASE_URL}/${encodeURIComponent(env.RUNPOD_ENDPOINT_ID)}${path}`;
}

async function runpodFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.RUNPOD_API_KEY}`);
  headers.set("accept", "application/json");
  const response = await fetch(endpointUrl(env, path), { ...init, headers });
  if (!response.ok) {
    const message = (await response.text()).slice(0, 1000);
    throw new ApiError(502, "runpod_error", `RunPod returned ${response.status}: ${message}`);
  }
  return response;
}

export async function submitRunpodJob(
  env: Env,
  payload: Record<string, unknown>,
  webhook: string,
): Promise<{ id: string; status: string }> {
  const response = await runpodFetch(env, "/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: payload,
      webhook,
      policy: {
        executionTimeout: 1_800_000,
        lowPriority: false,
        ttl: 7_200_000,
      },
    }),
  });
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.id !== "string" || typeof body.status !== "string") {
    throw new ApiError(502, "runpod_invalid_response", "RunPod returned an invalid submission response");
  }
  return { id: body.id, status: body.status };
}

export async function getRunpodStatus(
  env: Env,
  runpodJobId: string,
): Promise<RunpodStatusResponse> {
  const response = await runpodFetch(env, `/status/${encodeURIComponent(runpodJobId)}`, {
    method: "GET",
  });
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.id !== "string" || typeof body.status !== "string") {
    throw new ApiError(502, "runpod_invalid_response", "RunPod returned an invalid status response");
  }
  return {
    id: body.id,
    status: body.status,
    ...(typeof body.delayTime === "number" ? { delayTime: body.delayTime } : {}),
    ...(typeof body.executionTime === "number" ? { executionTime: body.executionTime } : {}),
    ...(body.output !== undefined ? { output: body.output } : {}),
    ...(body.error !== undefined ? { error: body.error } : {}),
  };
}

export async function cancelRunpodJob(
  env: Env,
  runpodJobId: string,
): Promise<{ id: string; status: string }> {
  const response = await runpodFetch(env, `/cancel/${encodeURIComponent(runpodJobId)}`, {
    method: "POST",
  });
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.id !== "string" || typeof body.status !== "string") {
    throw new ApiError(502, "runpod_invalid_response", "RunPod returned an invalid cancellation response");
  }
  return { id: body.id, status: body.status };
}

