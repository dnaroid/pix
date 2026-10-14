/** Text-only snapshots; never retain SDK trees or transcripts. Entries expire
 * lazily (no timers), and callers must validate current file identity first. */
export class SessionReadCache {
  constructor({ limit = 1024, ttlMs = 300000, maxBytes = 8192 } = {}) {
    this.entries = new Map(); this.limit = limit; this.ttlMs = ttlMs; this.maxBytes = maxBytes;
  }
  get(key, revision) {
    const cached = this.entries.get(key);
    if (!cached) return;
    if (cached.revision !== revision || cached.expires <= Date.now()) { this.entries.delete(key); return; }
    this.entries.delete(key); this.entries.set(key, cached);
    return { ...cached.value };
  }
  set(key, revision, value) {
    this.entries.delete(key);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > this.maxBytes) return;
    this.entries.set(key, { revision, value: { ...value }, expires: Date.now() + this.ttlMs });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
  }
}
