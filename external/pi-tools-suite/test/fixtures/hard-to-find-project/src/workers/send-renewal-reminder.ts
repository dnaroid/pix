import { renderRenewalReminder } from "../features/messaging/reminder-copy.js";
import { planRenewalReminder } from "../features/retention/renewal-preview.js";
import type { RenewalAccount } from "../features/retention/types.js";

export function sendRenewalReminder(account: RenewalAccount): string | undefined {
  const plan = planRenewalReminder(account, "live");
  if (!plan.shouldSend) return undefined;
  return renderRenewalReminder(plan.template, account.email);
}
