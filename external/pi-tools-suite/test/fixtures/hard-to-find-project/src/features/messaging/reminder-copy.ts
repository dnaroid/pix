export function renderRenewalReminder(template: string, email: string): string {
  if (template === "trial-ending-soon") return `Trial reminder for ${email}`;
  if (template === "paused-plan-renewal") return `Paused plan renewal reminder for ${email}`;
  return `Renewal reminder for ${email}`;
}

export function renderPreviewBanner(): string {
  return "Preview mode: no customer message is sent.";
}
