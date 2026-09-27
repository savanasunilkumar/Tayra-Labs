import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appOrigin,
  boundedJson,
  cookieOptions,
  safeDestination,
  trustedMutation,
} from "./auth-policy";
import {
  accountStorageKey,
  limitedStream,
  ownedStorageUrl,
  workspaceRoute,
} from "./workspace-policy";
afterEach(() => vi.unstubAllEnvs());
describe("session security boundaries", () => {
  it("requires exact origin and a custom header for every mutation", () => {
    vi.stubEnv("TAYRA_APP_ORIGIN", "https://app.tayra.example");
    const request = (origin: string, client = "workspace") =>
      new Request("https://app.tayra.example/api/auth/session", {
        method: "POST",
        headers: { origin, "x-tayra-client": client },
      });
    expect(trustedMutation(request("https://app.tayra.example"))).toBe(true);
    expect(trustedMutation(request("https://evil.example"))).toBe(false);
    expect(trustedMutation(request("https://app.tayra.example", ""))).toBe(
      false,
    );
    expect(cookieOptions()).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 432000,
    });
  });
  it("only permits HTTPS or explicit HTTP loopback", () => {
    for (const origin of [
      "http://evil.example",
      "ftp://127.0.0.1",
      "https://app.example/path",
      "https://u:p@app.example",
    ]) {
      vi.stubEnv("TAYRA_APP_ORIGIN", origin);
      expect(appOrigin).toThrow();
    }
  });
  it("does not accept external redirect destinations", () => {
    expect(safeDestination("/settings")).toBe("/settings");
    for (const destination of [
      "//evil.example",
      "https://evil.example",
      "/\\evil.example",
      "/login",
    ])
      expect(safeDestination(destination)).toBe("/overview");
  });
  it("bounds actual body bytes, not just a declared content length", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(200) }),
    });
    await expect(boundedJson(req, 30)).rejects.toThrow("too large");
  });
  it("isolates cached data by identity", () => {
    expect(accountStorageKey("history", "a")).not.toBe(
      accountStorageKey("history", "b"),
    );
    expect(accountStorageKey("pending", "a")).not.toBe(
      accountStorageKey("history", "a"),
    );
  });
});
describe("workspace proxy security", () => {
  const id = "8f0ddf81-43eb-4cbb-8fcd-a6cbd0c19d5f";
  it("has no pilot data, IAM, compute, or arbitrary proxy routes", () => {
    expect(workspaceRoute("GET", `jobs/${id}/result`)).toBe(true);
    for (const path of [
      "sample/video",
      "../health",
      "compute/resume",
      "https://evil.example",
      "auth/session",
    ])
      expect(workspaceRoute("GET", path)).toBe(false);
  });
  it("accepts only the owner’s exact storage object", () => {
    const good = `https://storage.googleapis.com/video-api-dev-509820-video-api-media/result/user_a/${id}/result.json?signature=example`;
    expect(ownedStorageUrl(good, "user_a", id, "result").hostname).toBe(
      "storage.googleapis.com",
    );
    for (const url of [
      good.replace("user_a", "user_b"),
      good.replace("storage.googleapis.com", "evil.example"),
      good.replace("result.json", "other.json"),
      good.replace("https:", "http:"),
    ])
      expect(() => ownedStorageUrl(url, "user_a", id, "result")).toThrow();
  });
  it("rejects truncated and oversized streamed uploads", async () => {
    const body = () => new Blob(["1234"]).stream();
    await expect(
      new Response(limitedStream(body(), 4, true)).text(),
    ).resolves.toBe("1234");
    await expect(
      new Response(limitedStream(body(), 3, true)).text(),
    ).rejects.toThrow();
    await expect(
      new Response(limitedStream(body(), 5, true)).text(),
    ).rejects.toThrow();
  });
});
