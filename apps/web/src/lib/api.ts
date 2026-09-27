export type Session = {
  api_base_url?: string;
  api_iam?: boolean;
  token: string;
  model: string;
  project: string;
  sample_available: boolean;
  saved_job: string;
};
export type Health = {
  analysis_enabled: boolean;
  api_model_id?: string;
  model: string;
  status: string;
};
export type Metrics = {
  worker_ms?: number;
  gpu_execution_ms?: number;
  video_seconds?: number;
  output_tokens?: number;
};
export type Job = {
  id: string;
  asset_id?: string;
  status: string;
  created_at?: string | number;
  filename?: string;
  metrics?: Metrics;
  error?: { message?: string };
};
export type Result = {
  job_id: string;
  model?: string;
  model_id: string;
  model_revision: string;
  output: { text: string };
  metrics: Metrics;
  media?: { duration_seconds: number };
};
export type Recent = {
  id: string;
  label: string;
  status: string;
  date: number;
  metrics?: Metrics;
};
export type Pending = {
  key: string;
  label: string;
  body: {
    asset_id: string;
    model?: string;
    prompt: string;
    max_new_tokens: number;
  };
};
export const terminal = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  _token = "",
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/workspace/${path}`, {
    ...options,
    cache: "no-store",
    headers: {
      "X-Tayra-Client": "workspace",
      ...(options.body && typeof options.body === "string"
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  const data =
    response.status === 204
      ? {}
      : await response.json().catch(() => {
          throw new ApiError(
            "The API returned an unreadable response. Retry the existing request if submission was interrupted.",
            response.status,
          );
        });
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined")
      window.location.replace("/login");
    throw new ApiError(
      typeof data.error === "string"
        ? data.error
        : typeof data.error?.message === "string"
          ? data.error.message
          : `Request failed (${response.status}).`,
      response.status,
    );
  }
  return data as T;
}
export async function sampleFile() {
  const response = await fetch("/api/workspace/sample/video", {
    headers: { "X-Tayra-Client": "workspace" },
  });
  if (!response.ok)
    throw new Error("The sample is unavailable. Choose your own video.");
  return new File([await response.blob()], "penguins-10s.mp4", {
    type: "video/mp4",
  });
}
export const videoTypes: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};
export function validateVideo(file: Pick<File, "name" | "size">) {
  const type = videoTypes[file.name.split(".").pop()?.toLowerCase() ?? ""];
  if (!type) return "Choose an MP4, MOV, or WebM video.";
  if (!file.size || file.size > 500 * 1024 * 1024)
    return "Choose a non-empty video up to 500 MiB.";
  return null;
}
export function seconds(ms?: number) {
  return ms === undefined ? "—" : `${(ms / 1000).toFixed(2)}s`;
}
export function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
export async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}
export function downloadResult(result: Result) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `tayra-${result.job_id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
