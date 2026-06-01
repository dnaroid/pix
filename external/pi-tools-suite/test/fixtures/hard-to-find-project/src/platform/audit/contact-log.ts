export interface ContactLogEntry {
  accountId: string;
  channel: "email" | "sms" | "support";
  contactedAt: string;
  dryRun?: boolean;
}

const entries: ContactLogEntry[] = [];

export function recordContact(entry: ContactLogEntry): void {
  // Decoy: audit-only append. It does not control reminder eligibility.
  entries.push({ ...entry });
}

export function listContacts(accountId: string): ContactLogEntry[] {
  return entries.filter((entry) => entry.accountId === accountId).map((entry) => ({ ...entry }));
}
