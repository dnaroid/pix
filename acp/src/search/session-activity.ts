import type { SessionMapRecord } from "../acp/session-map.js";

/** Serialize native-identity resolution with events, including fork/close, so
 * a slow map read cannot resurrect an already settled run. */
export class SessionSearchActivity {
  private readonly sessions = new Map<string, { queue: Promise<void>; native?: SessionMapRecord; running: boolean }>();
  private stopped = false;
  constructor(
    private readonly resolve: (id: string) => Promise<SessionMapRecord | undefined>,
    private readonly observe: (cwd: string, id: string, running: boolean) => Promise<void>,
  ) {}
  update(id: string, running: boolean, closing = false): Promise<void> {
    if (this.stopped && !closing) return Promise.resolve();
    let state = this.sessions.get(id);
    if (!state) { state = { queue: Promise.resolve(), running: false }; this.sessions.set(id, state); }
    const current = state;
    const operation = current.queue.catch(() => {}).then(async () => {
      const old = current.native;
      if (closing) {
        if (old && current.running) await this.observe(old.cwd, old.piSessionId, false);
        current.running = false;
        return;
      }
      const record = await this.resolve(id);
      if (old && current.running && (old.piSessionId !== record?.piSessionId || old.cwd !== record?.cwd)) {
        await this.observe(old.cwd, old.piSessionId, false);
      }
      if (record) {
        current.native = record;
        current.running = running;
        await this.observe(record.cwd, record.piSessionId, running);
      }
    });
    current.queue = operation;
    if (closing) void operation.finally(() => {
      if (current.queue === operation) this.sessions.delete(id);
    }).catch(() => {});
    return operation;
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.sessions.keys()].map(id => this.update(id, false, true)));
  }
}
