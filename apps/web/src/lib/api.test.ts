import { describe, expect, it } from "vitest";
import { allowedRoute, trustedRequest, upstreamPath } from "./bridge-policy";
import { validateVideo, seconds } from "./api";

const id = "8f0ddf81-43eb-4cbb-8fcd-a6cbd0c19d5f";
describe("local adapter security", () => {
  it("only forwards supported routes and methods", () => {
    expect(allowedRoute("GET", `jobs/${id}/result`)).toBe(true);
    expect(allowedRoute("PUT", `assets/${id}/content`)).toBe(true);
    for (const path of [
      "https://evil.example",
      "../health",
      "jobs/not-a-uuid",
      "compute/resume",
      "secrets",
      "assets/../../health",
    ]) {
      expect(allowedRoute("GET", path)).toBe(false);
    }
    expect(allowedRoute("DELETE", `jobs/${id}`)).toBe(false);
    expect(upstreamPath("sample/video")).toBe("/sample/video");
    expect(upstreamPath("health")).toBe("/api/health");
  });
  it("rejects cross-site, arbitrary host, and unmarked requests", () => {
    const headers = new Headers({
      host: "127.0.0.1:3100",
      "x-tayra-client": "workspace",
    });
    expect(trustedRequest(headers)).toBe(true);
    for (const [key, value] of [
      ["host", "evil.example"],
      ["origin", "https://evil.example"],
      ["sec-fetch-site", "cross-site"],
      ["x-tayra-client", ""],
    ]) {
      const changed = new Headers(headers);
      changed.set(key, value);
      expect(trustedRequest(changed)).toBe(false);
    }
  });
});
describe("video input", () => {
  it("accepts supported files and rejects invalid uploads", () => {
    expect(validateVideo({ name: "demo.MP4", size: 4 })).toBeNull();
    expect(validateVideo({ name: "demo.webm", size: 0 })).not.toBeNull();
    expect(
      validateVideo({ name: "demo.mov", size: 501 * 1024 * 1024 }),
    ).not.toBeNull();
    expect(validateVideo({ name: "demo.txt", size: 10 })).not.toBeNull();
  });
  it("does not invent missing measurements", () => {
    expect(seconds(undefined)).toBe("—");
    expect(seconds(3144)).toBe("3.14s");
  });
});
