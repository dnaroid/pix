export type JobState = "running" | "done" | "failed" | "cancelled";

export function cancelJob(state: JobState): JobState {
  return state === "running" ? "cancelled" : state;
}
