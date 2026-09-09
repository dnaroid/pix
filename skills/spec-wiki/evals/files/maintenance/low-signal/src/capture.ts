export function capture(idempotencyKey: string, previous?: string): string {
  return previous ?? `capture:${idempotencyKey}`;
}
