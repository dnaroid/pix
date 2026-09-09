const captures = new Map<string, { amount: number; id: string }>();

export function capture(key: string, amount: number): { amount: number; id: string } {
  const existing = captures.get(key);
  if (existing) {
    if (existing.amount !== amount) throw new Error("idempotency conflict");
    return existing;
  }
  const result = { amount, id: `capture-${captures.size + 1}` };
  captures.set(key, result);
  return result;
}
