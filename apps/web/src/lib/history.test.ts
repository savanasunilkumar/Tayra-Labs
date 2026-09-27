import { describe, expect, it } from "vitest";
import { analysisRows, REFERENCE_JOB } from "./history";
import type { Recent } from "./api";

const rows: Recent[] = [
  {
    id: REFERENCE_JOB,
    label: "Reference clip",
    status: "succeeded",
    date: 400,
  },
  {
    id: "completed",
    label: "Launch video.mp4",
    status: "succeeded",
    date: 100,
  },
  { id: "queued", label: "Interview.mov", status: "queued", date: 300 },
  { id: "failed", label: "Recording.webm", status: "failed", date: 200 },
];
describe("analysis history", () => {
  it("keeps the reference separate without mutating stored records", () => {
    const result = analysisRows(rows);
    expect(result.map((row) => row.id)).toEqual([
      "queued",
      "failed",
      "completed",
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[0].id).toBe(REFERENCE_JOB);
  });
  it("excludes a configured reference and matches trimmed, case-insensitive search", () => {
    expect(
      analysisRows(rows, { referenceJob: "queued", query: "  LAUNCH  " }).map(
        (row) => row.id,
      ),
    ).toEqual(["completed"]);
    expect(analysisRows(rows, { referenceJob: "queued" })).toHaveLength(2);
  });
  it("separates completed, active, and unsuccessful analyses", () => {
    expect(
      analysisRows(rows, { status: "completed" }).map((row) => row.id),
    ).toEqual(["completed"]);
    expect(
      analysisRows(rows, { status: "active" }).map((row) => row.id),
    ).toEqual(["queued"]);
    expect(
      analysisRows(rows, { status: "unsuccessful" }).map((row) => row.id),
    ).toEqual(["failed"]);
  });
});
