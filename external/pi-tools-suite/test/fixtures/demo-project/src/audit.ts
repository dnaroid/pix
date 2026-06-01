export interface AuditEvent {
  type: "checkout_started" | "payment_requested" | "checkout_failed";
  userId: string;
  metadata?: Record<string, unknown>;
}

const events: AuditEvent[] = [];

export function recordAuditEvent(event: AuditEvent): void {
  events.push({ ...event, metadata: { ...event.metadata } });
}

export function listAuditEvents(): AuditEvent[] {
  return events.map((event) => ({ ...event, metadata: { ...event.metadata } }));
}
