/** Product identity is separate from the pinned upstream checkpoint. */
export const ELANUS = {
  family: "Elanus",
  name: "Elanus 1 · 8B",
  id: "elanus-1-8b",
  checkpoint: "allenai/Molmo2-8B",
  revision: "e28fa28597e5ec5e0cca2201dd8ab33d48bc4a1b",
  provider: "Allen Institute for AI",
} as const;

export function modelName(id: string) {
  return id === ELANUS.id || id === ELANUS.checkpoint ? ELANUS.name : id;
}
