export class SessionReadCache<T extends object> {
  constructor(options?: { limit?: number; ttlMs?: number; maxBytes?: number });
  get(key: string, revision: string): T | undefined;
  set(key: string, revision: string, value: T): void;
}
