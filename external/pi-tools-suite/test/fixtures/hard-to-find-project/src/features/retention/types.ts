export type ReminderMode = "live" | "preview";

export interface RenewalAccount {
  id: string;
  email: string;
  plan: "trial" | "monthly" | "annual";
  status: "active" | "quiet" | "paused";
  markers: {
    lastPulseAt?: string;
    lastInvoiceAt?: string;
    lastReminderTemplate?: string;
  };
}

export interface RenewalReminderPlan {
  accountId: string;
  template: string;
  shouldSend: boolean;
  reason: string;
  markers: RenewalAccount["markers"];
}
