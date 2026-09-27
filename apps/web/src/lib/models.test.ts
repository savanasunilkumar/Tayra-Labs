import { describe, expect, it } from "vitest";
import { ELANUS, modelName } from "./models";

describe("Elanus release identity", () => {
  it("keeps the public API ID separate from the upstream checkpoint", () => {
    expect(ELANUS.family).toBe("Elanus");
    expect(ELANUS.name).toBe("Elanus 1 · 8B");
    expect(ELANUS.id).toBe("elanus-1-8b");
    expect(ELANUS.checkpoint).toBe("allenai/Molmo2-8B");
    expect(ELANUS.revision).toBe("e28fa28597e5ec5e0cca2201dd8ab33d48bc4a1b");
  });

  it("recognizes current and legacy IDs without inventing names for other models", () => {
    expect(modelName(ELANUS.id)).toBe(ELANUS.name);
    expect(modelName(ELANUS.checkpoint)).toBe(ELANUS.name);
    expect(modelName("different-model")).toBe("different-model");
  });
});
