import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  backend: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: mocks.set, get: mocks.get }),
}));
vi.mock("@/lib/backend", () => ({
  backendJson: mocks.backend,
  BackendError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { POST } from "./route";
function request(
  action: string,
  body: unknown = {},
  origin = "http://127.0.0.1:3100",
) {
  return POST(
    new Request(`http://127.0.0.1:3100/api/auth/${action}`, {
      method: "POST",
      headers: {
        origin,
        "x-tayra-client": "workspace",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ action }) },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReturnValue({ value: "existing-session" });
});
describe("session route", () => {
  it("rejects login CSRF before exchanging credentials", async () => {
    expect(
      (await request("session", { id_token: "token" }, "https://evil.example"))
        .status,
    ).toBe(403);
    expect(mocks.backend).not.toHaveBeenCalled();
  });
  it("mints an HttpOnly cookie but never returns it or the ID token in JSON", async () => {
    mocks.backend.mockResolvedValue({
      session_cookie: "secret-session",
      user: { id: "alice", email_verified: true },
    });
    const response = await request("session", {
      id_token: "opaque-id-token",
      uid: "fake-admin",
    });
    expect(await response.json()).toEqual({
      user: { id: "alice", email_verified: true },
    });
    expect(mocks.backend.mock.calls[0][1].body).toBe(
      JSON.stringify({ id_token: "opaque-id-token" }),
    );
    expect(mocks.set).toHaveBeenCalledWith(
      "tayra_session",
      "secret-session",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("never sets a cookie for an unverified email", async () => {
    mocks.backend.mockResolvedValue({
      session_cookie: "secret",
      user: { email_verified: false },
    });
    expect((await request("session", { id_token: "opaque" })).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("rejects missing or oversized tokens", async () => {
    for (const body of [{}, { id_token: "" }, { id_token: "x".repeat(8200) }])
      expect((await request("session", body)).status).toBe(400);
    expect(mocks.backend).not.toHaveBeenCalled();
  });
  it("signs out locally without requiring a valid backend session", async () => {
    expect((await request("logout")).status).toBe(200);
    expect(mocks.backend).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith(
      "tayra_session",
      "",
      expect.objectContaining({ maxAge: 0 }),
    );
  });
  it("revokes all sessions using only the server cookie", async () => {
    mocks.backend.mockResolvedValue({});
    expect((await request("logout-all", { uid: "another-user" })).status).toBe(
      200,
    );
    expect(mocks.backend).toHaveBeenCalledWith(
      "/v1/auth/logout-all",
      { method: "POST" },
      "existing-session",
    );
  });
});
