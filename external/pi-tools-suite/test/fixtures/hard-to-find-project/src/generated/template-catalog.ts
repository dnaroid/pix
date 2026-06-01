export const TEMPLATE_CATALOG = [
  "trial-ending-soon",
  "paused-plan-renewal",
  "quiet-account-renewal",
  "invoice-ready",
  "payment-method-expiring",
  "support-follow-up",
] as const;

export type TemplateName = typeof TEMPLATE_CATALOG[number];
