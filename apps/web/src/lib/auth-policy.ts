export const SESSION_COOKIE = "tayra_session";
export const SESSION_SECONDS = 5 * 24 * 60 * 60;

export function appOrigin() {
  const value = process.env.TAYRA_APP_ORIGIN ?? "http://127.0.0.1:3100";
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
  ) {
    throw new Error(
      "TAYRA_APP_ORIGIN must be HTTPS, or loopback for local development",
    );
  }
  return value;
}

export function trustedMutation(request: Request) {
  return (
    request.headers.get("origin") === appOrigin() &&
    request.headers.get("x-tayra-client") === "workspace" &&
    request.headers.get("sec-fetch-site") !== "cross-site"
  );
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: appOrigin().startsWith("https:"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_SECONDS,
  };
}

export function safeDestination(value: string | null) {
  return value &&
    /^\/(overview|analyze|models|access|reference|settings)$/.test(value)
    ? value
    : "/overview";
}

export async function boundedJson(request: Request, limit = 16384) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("Use a JSON request");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Request body is required");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error("Request is too large");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
