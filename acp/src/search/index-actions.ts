import { bounded } from "./bounded.js";

/** Coalesce overlapping clicks, not future retries. Each caller owns its wait;
 * paid work is cancelled only once every waiting caller has left. */
export class IndexActions<T> {
  private readonly actions = new Map<string, { controller: AbortController; waiters: number; promise: Promise<T> }>();
  async run(key: string, caller: AbortSignal, lifetime: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    caller.throwIfAborted();
    lifetime.throwIfAborted();
    let action = this.actions.get(key);
    if (!action) {
      const controller = new AbortController();
      const signal = AbortSignal.any([lifetime, controller.signal]);
      const created = { controller, waiters: 0, promise: undefined as unknown as Promise<T> };
      created.promise = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); })
        .finally(() => { if (this.actions.get(key) === created) this.actions.delete(key); });
      // A caller can leave before bounded's continuation attaches its handler.
      void created.promise.catch(() => {});
      action = created;
      this.actions.set(key, action);
    }
    action.waiters++;
    try { return await bounded(AbortSignal.any([caller, lifetime]), undefined, () => action!.promise); }
    finally { if (--action.waiters === 0) action.controller.abort(); }
  }
  async settled(): Promise<void> { await Promise.allSettled([...this.actions.values()].map(action => action.promise)); }
}
