import "server-only";
import { GoogleAuth } from "google-auth-library";

export class BackendError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function backendUrl() {
  const value = process.env.TAYRA_API_URL;
  if (!value)
    throw new BackendError(503, "Account services are not configured yet.");
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      ))
  )
    throw new BackendError(
      503,
      "Account services are not configured correctly.",
    );
  return value;
}

export async function backend(
  path: string,
  init: RequestInit = {},
  session?: string,
) {
  const base = backendUrl();
  const headers = new Headers(init.headers);
  if (session) headers.set("Authorization", `Session ${session}`);
  try {
    if (process.env.TAYRA_API_IAM === "true") {
      const auth = new GoogleAuth({ projectId: "video-api-dev-509820" });
      const client = await auth.getIdTokenClient(base);
      const identity = await client.idTokenProvider.fetchIdToken(base);
      headers.set("X-Serverless-Authorization", `Bearer ${identity}`);
    }
    return await fetch(base + path, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new BackendError(
      503,
      "Account services are temporarily unavailable. Please try again.",
    );
  }
}

export async function backendJson<T>(
  path: string,
  init: RequestInit = {},
  session?: string,
): Promise<T> {
  const response = await backend(path, init, session);
  const value =
    response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok)
    throw new BackendError(
      response.status,
      typeof value.error?.message === "string"
        ? value.error.message
        : "The request could not be completed.",
    );
  return value as T;
}
