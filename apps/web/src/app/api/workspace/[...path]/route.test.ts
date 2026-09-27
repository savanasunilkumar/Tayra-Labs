import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ account: vi.fn(), backend: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "server-session" }) }),
}));
vi.mock("@/lib/session", () => ({ currentAccount: mocks.account }));
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
import { GET, PATCH, POST, PUT } from "./route";
const id = "8f0ddf81-43eb-4cbb-8fcd-a6cbd0c19d5f";
const account = { id: "alice", workspace_id: "user_a", email_verified: true };
function request(
  method: string,
  path: string,
  body?: string,
  extra: Record<string, string> = {},
) {
  const handler = { GET, POST, PATCH, PUT }[method]!;
  return handler(
    new Request(`http://127.0.0.1:3100/api/workspace/${path}`, {
      method,
      headers: {
        origin: "http://127.0.0.1:3100",
        "x-tayra-client": "workspace",
        "content-type": "application/json",
        ...extra,
      },
      body,
    }),
    { params: Promise.resolve({ path: path.split("/") }) },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.account.mockResolvedValue(account);
  mocks.backend.mockResolvedValue({ jobs: [] });
});
describe("authenticated workspace BFF", () => {
  it("denies missing and unverified accounts before backend access", async () => {
    mocks.account.mockResolvedValue(null);
    expect((await request("GET", "jobs")).status).toBe(401);
    mocks.account.mockResolvedValue({ ...account, email_verified: false });
    expect((await request("GET", "jobs")).status).toBe(403);
    expect(mocks.backend).not.toHaveBeenCalled();
  });
  it("does not forward client authorization, user IDs, or pilot tokens", async () => {
    const response = await request("GET", "jobs", undefined, {
      Authorization: "Bearer attacker",
      "x-user-id": "bob",
      "x-playground-token": "pilot",
    });
    expect(response.status).toBe(200);
    expect(mocks.backend).toHaveBeenCalledWith(
      "/v1/jobs",
      { method: "GET", headers: { "Content-Type": "application/json" } },
      "server-session",
    );
  });
  it("rejects cross-origin profile writes", async () => {
    expect(
      (await request("PATCH", "me", "{}", { origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect(mocks.backend).not.toHaveBeenCalled();
  });
  it("does not expose signed upload credentials in registration", async () => {
    mocks.backend.mockResolvedValue({
      asset: { id },
      upload: { url: "secret-url" },
    });
    const response = await request("POST", "assets", "{}");
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ asset: { id } });
  });
  it("forwards idempotency keys for the authenticated session", async () => {
    expect(
      (
        await request("POST", "jobs", "{}", {
          "idempotency-key": "request-123",
        })
      ).status,
    ).toBe(200);
    expect(mocks.backend.mock.calls[0][1].headers["Idempotency-Key"]).toBe(
      "request-123",
    );
  });
  it("rejects unregistered or mismatched upload lengths", async () => {
    mocks.backend.mockResolvedValue({
      asset: { expected_bytes: 4, content_type: "video/mp4" },
      upload: { url: "invalid" },
    });
    expect(
      (
        await request("PUT", `assets/${id}/content`, "123", {
          "content-length": "3",
        })
      ).status,
    ).toBe(413);
  });
});
