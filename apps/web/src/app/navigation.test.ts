import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error("redirect:" + path);
  },
  notFound: () => {
    throw new Error("not-found");
  },
}));
vi.mock("@/components/workspace-pages", () => ({ WorkspacePage: () => null }));
vi.mock("@/components/workspace-shell", () => ({ WorkspaceShell: () => null }));
vi.mock("@/lib/session", () => ({
  requireAccount: vi.fn(async () => {
    throw new Error("redirect:/login");
  }),
  authConfig: () => ({}),
}));

import RootPage from "./page";
import SectionPage from "./[section]/page";

describe("workspace navigation", () => {
  it("opens Overview by default with only one Analyze destination", () => {
    expect(() => RootPage()).toThrow("redirect:/overview");
  });
  it("requires a verified account for every workspace page", async () => {
    for (const section of [
      "overview",
      "analyze",
      "models",
      "access",
      "reference",
      "settings",
    ]) {
      await expect(
        SectionPage({ params: Promise.resolve({ section }) }),
      ).rejects.toThrow("redirect:/login");
    }
  });
  it("preserves old history and playground bookmarks", async () => {
    for (const section of ["analyses", "activity"]) {
      await expect(
        SectionPage({ params: Promise.resolve({ section }) }),
      ).rejects.toThrow("redirect:/overview");
    }
    await expect(
      SectionPage({ params: Promise.resolve({ section: "playground" }) }),
    ).rejects.toThrow("redirect:/analyze");
  });
  it("does not resolve unknown routes as settings", async () => {
    await expect(
      SectionPage({ params: Promise.resolve({ section: "missing" }) }),
    ).rejects.toThrow("not-found");
  });
});
