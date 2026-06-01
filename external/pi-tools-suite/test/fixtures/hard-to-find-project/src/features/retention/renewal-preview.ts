import { systemClock } from "../../platform/clock/wall-clock.js";
import { foldPacketEdges } from "../../platform/transit/packet-fold.js";
import { makeRehearsalNode } from "../../platform/transit/rehearsal-node.js";
import { chooseRenewalTemplate, shouldQueueRenewalReminder } from "./reminder-policy.js";
import type { ReminderMode, RenewalAccount, RenewalReminderPlan } from "./types.js";

export function planRenewalReminder(account: RenewalAccount, mode: ReminderMode): RenewalReminderPlan {
  const clock = systemClock();
  const template = chooseRenewalTemplate(account);
  const shouldSend = shouldQueueRenewalReminder(account, clock);

  const node = makeRehearsalNode({
    actorId: account.id,
    lane: "retention",
    intent: mode === "preview" ? "shadow" : "commit",
    state: { markers: account.markers, template },
  });

  const folded = foldPacketEdges({
    node,
    clock,
    edge: { disposition: mode === "preview" ? "observe" : "deliver", route: "renewal-nudge" },
  });

  return {
    accountId: account.id,
    template,
    shouldSend,
    reason: shouldSend ? "eligible" : "recent-pulse",
    markers: folded.state.markers,
  };
}
