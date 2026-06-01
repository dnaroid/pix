import type { RenewalReminderPlan } from "./types.js";

const previews: RenewalReminderPlan[] = [];

export function rememberDryRun(plan: RenewalReminderPlan): void {
  // Decoy: this in-memory list is only for UI diffing and is never persisted.
  previews.push({ ...plan, markers: { ...plan.markers } });
}

export function listDryRuns(): RenewalReminderPlan[] {
  return previews.map((plan) => ({ ...plan, markers: { ...plan.markers } }));
}
