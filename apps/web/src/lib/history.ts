import { terminal, type Recent } from "./api";

// The reference result is offered separately, never seeded into user activity.
export const REFERENCE_JOB = "8f0ddf81-43eb-4cbb-8fcd-a6cbd0c19d5f";
export function analysisRows(
  recent: Recent[],
  options: { referenceJob?: string; query?: string; status?: string } = {},
) {
  const query = (options.query ?? "").trim().toLowerCase();
  return recent
    .filter(
      (row) => row.id !== REFERENCE_JOB && row.id !== options.referenceJob,
    )
    .filter((row) => `${row.label} ${row.id}`.toLowerCase().includes(query))
    .filter((row) => {
      switch (options.status) {
        case "completed":
          return row.status === "succeeded";
        case "active":
          return !terminal.has(row.status);
        case "unsuccessful":
          return terminal.has(row.status) && row.status !== "succeeded";
        default:
          return true;
      }
    })
    .sort((a, b) => b.date - a.date);
}
