// Fixed, loopback-only development adapter. Never turn this into a public proxy.
export const BRIDGE = "http://127.0.0.1:3000";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const routes = [
  ["GET", /^session$/],
  ["GET", /^health$/],
  ["GET", /^sample\/video$/],
  ["POST", /^assets$/],
  ["POST", /^jobs$/],
  ["PUT", new RegExp(`^assets/${UUID}/content$`, "i")],
  ["DELETE", new RegExp(`^assets/${UUID}$`, "i")],
  ["GET", new RegExp(`^jobs/${UUID}(/result)?$`, "i")],
  ["POST", new RegExp(`^jobs/${UUID}/cancel$`, "i")],
] as const;

export function allowedRoute(method: string, path: string) {
  return routes.some(
    ([verb, pattern]) => verb === method && pattern.test(path),
  );
}
export function trustedRequest(headers: Headers) {
  const host = headers.get("host");
  const origin = headers.get("origin");
  return (
    ["127.0.0.1:3100", "localhost:3100"].includes(host ?? "") &&
    (!origin ||
      ["http://127.0.0.1:3100", "http://localhost:3100"].includes(origin)) &&
    headers.get("sec-fetch-site") !== "cross-site" &&
    headers.get("x-tayra-client") === "workspace"
  );
}
export function upstreamPath(path: string) {
  return path === "sample/video" ? "/sample/video" : `/api/${path}`;
}
