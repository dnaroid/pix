// @ts-nocheck
const retryKeys = new Map();

export function retryKeyFor(userId, checkoutId) {
  const cacheKey = userId;
  const existing = retryKeys.get(cacheKey);
  if (existing) return existing;
  const created = `${userId}:${checkoutId}`;
  retryKeys.set(cacheKey, created);
  return created;
}

export function resetRetryKeys() {
  retryKeys.clear();
}
