import { describe, expect, it, vi } from "vitest";
import type { SupervisorMandatePatch, SupervisorMandateResponse } from "../../../acp/src/acp/supervisor-contract";
import { createSupervisorMandate, mandatePatch } from "./supervisor-mandate.svelte";

const BASE: SupervisorMandateResponse = {
  enabled: false, paused: false, maxConcurrent: 5, maxReworkRounds: 5, stalledAfterMinutes: 15,
  policy: "", managed: 0, manual: 0, running: 0, reworkRounds: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const calls: { cwd: string; patch?: SupervisorMandatePatch; reply: ReturnType<typeof deferred<SupervisorMandateResponse>> }[] = [];
  const client = {
    supervisorMandate: vi.fn((cwd: string, patch?: SupervisorMandatePatch) => {
      const reply = deferred<SupervisorMandateResponse>();
      calls.push({ cwd, ...(patch ? { patch } : {}), reply });
      return reply.promise;
    }),
  };
  let current: typeof client | null = client;
  let workspace = "/project";
  const reportError = vi.fn();
  const reportWarning = vi.fn();
  const store = createSupervisorMandate({ client: () => current, workspace: () => workspace, reportError, reportWarning });
  return {
    store, client, calls, reportError, reportWarning,
    switchProject: (next: string) => { workspace = next; },
    disconnect: () => { current = null; },
  };
}

describe("supervisor mandate store", () => {
  it("joins concurrent background reads and publishes the result", async () => {
    const f = fixture();
    const first = f.store.refresh();
    const second = f.store.refresh();
    expect(f.calls).toHaveLength(1);
    f.calls[0]!.reply.resolve({ ...BASE, managed: 2 });
    await Promise.all([first, second]);
    expect(f.store.mandate?.managed).toBe(2);
  });

  it("drops a read that lands after a project switch and hides the old snapshot", async () => {
    const f = fixture();
    await Promise.all([f.store.refresh(), Promise.resolve().then(() => f.calls[0]!.reply.resolve(BASE))]);
    expect(f.store.mandate).not.toBeNull();
    const late = f.store.refresh();
    f.switchProject("/other");
    expect(f.store.mandate).toBeNull();
    f.calls[1]!.reply.resolve({ ...BASE, enabled: true });
    expect(await late).toBe(false);
    f.switchProject("/project");
    expect(f.store.mandate?.enabled).toBe(false);
  });

  it("logs background read failures without showing them, and shows failed changes", async () => {
    const f = fixture();
    const read = f.store.refresh();
    f.calls[0]!.reply.reject(new Error("offline"));
    await read;
    expect(f.reportWarning).toHaveBeenCalledOnce();
    expect(f.reportError).not.toHaveBeenCalled();
    const change = f.store.update({ paused: true });
    f.calls[1]!.reply.reject(new Error("denied"));
    expect(await change).toBe(false);
    expect(f.reportError).toHaveBeenCalledOnce();
  });

  it("skips background reads while a change saves, so polling cannot overwrite it", async () => {
    const f = fixture();
    const change = f.store.update({ paused: true });
    expect(f.store.saving).toBe(true);
    await f.store.refresh();
    expect(f.calls).toHaveLength(1);
    f.calls[0]!.reply.resolve({ ...BASE, enabled: true, paused: true });
    expect(await change).toBe(true);
    expect(f.store.saving).toBe(false);
    expect(f.store.mandate?.paused).toBe(true);
  });

  it("keeps the form open when saving fails and closes it on success", async () => {
    const f = fixture();
    const read = f.store.refresh();
    f.calls[0]!.reply.resolve(BASE);
    await read;
    f.store.openEditor(true);
    expect(f.store.editor).toMatchObject({ enable: true });
    const draft = { enabled: true, maxConcurrent: 3, maxReworkRounds: 5, stalledAfterMinutes: 15, policy: "", workerModelRef: "" };
    const failing = f.store.save(draft);
    expect(f.calls[1]!.patch).toEqual({ enabled: true, maxConcurrent: 3 });
    f.calls[1]!.reply.reject(new Error("write failed"));
    await failing;
    expect(f.store.editor).not.toBeNull();
    const saving = f.store.save(draft);
    f.calls[2]!.reply.resolve({ ...BASE, enabled: true, maxConcurrent: 3 });
    await saving;
    expect(f.store.editor).toBeNull();
  });

  it("saves a worker model from the form and clears it when the field is blank", async () => {
    const f = fixture();
    const read = f.store.refresh();
    f.calls[0]!.reply.resolve(BASE);
    await read;

    const workerModelRef = "provider/model:high";
    f.store.openEditor();
    const saving = f.store.save({ ...BASE, workerModelRef: ` ${workerModelRef} ` });
    expect(f.calls[1]!.patch).toEqual({ workerModelRef });
    f.calls[1]!.reply.resolve({ ...BASE, workerModelRef });
    await saving;
    expect(f.store.mandate?.workerModelRef).toBe(workerModelRef);

    f.store.openEditor();
    const clearing = f.store.save({ ...BASE, workerModelRef: "" });
    expect(f.calls[2]!.patch).toEqual({ workerModelRef: null });
    f.calls[2]!.reply.resolve(BASE);
    await clearing;
    expect(f.store.mandate?.workerModelRef).toBeUndefined();
  });

  it("drops an open form after a project switch", async () => {
    const f = fixture();
    const read = f.store.refresh();
    f.calls[0]!.reply.resolve(BASE);
    await read;
    f.store.openEditor();
    f.switchProject("/other");
    expect(f.store.editor).toBeNull();
    f.store.reconcile();
    f.switchProject("/project");
    expect(f.store.editor).toBeNull();
  });

  it("does nothing without a client", async () => {
    const f = fixture();
    f.disconnect();
    expect(await f.store.refresh()).toBe(false);
    expect(f.client.supervisorMandate).not.toHaveBeenCalled();
  });

  it("polls while watched and stops after cleanup", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const stop = f.store.watch(1_000);
      expect(f.calls).toHaveLength(1);
      f.calls[0]!.reply.resolve(BASE);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.calls).toHaveLength(2);
      f.calls[1]!.reply.resolve(BASE);
      stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("patches only the changed fields", () => {
    expect(mandatePatch(BASE, { ...BASE, workerModelRef: "  " })).toEqual({});
    const workerModelRef = "provider/model:high";
    expect(mandatePatch({ ...BASE, workerModelRef }, { ...BASE, workerModelRef })).toEqual({});
    expect(mandatePatch(BASE, { ...BASE, enabled: true, maxReworkRounds: 2, stalledAfterMinutes: 30, policy: "x", workerModelRef: "" }))
      .toEqual({ enabled: true, maxReworkRounds: 2, stalledAfterMinutes: 30, policy: "x" });
  });
});
