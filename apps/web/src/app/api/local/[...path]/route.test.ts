import { expect, it, vi } from "vitest";
import { GET, POST, PUT, DELETE } from "./route";
it("never forwards shared pilot credentials or data", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const method of [GET, POST, PUT, DELETE])
    expect((await method()).status).toBe(410);
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});
