import { describe, expect, it } from "vitest";
import { createKnowledgeJudgeGate } from "./knowledge-judge-gate";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("shared Wiki judge slot", () => {
  it("serializes pre-save and queued work and gives waiting manual checks priority", async () => {
    const gate = createKnowledgeJudgeGate(), first = deferred<string>();
    const order: string[] = [], signal = new AbortController().signal;
    const active = gate.run(() => { order.push("active"); return first.promise; }, signal, true);
    await flush();
    const background = gate.run(async () => { order.push("background"); return "background"; }, signal, true);
    const save = gate.run(async () => { order.push("save"); return "save"; }, signal);
    await flush();
    expect(order).toEqual(["active"]);
    first.resolve("active");
    await Promise.all([active, background, save]);
    expect(order).toEqual(["active", "save", "background"]);
  });

  it("keeps the physical slot after abort until an ignoring provider actually settles", async () => {
    const gate = createKnowledgeJudgeGate(), provider = deferred<string>();
    const controller = new AbortController(), order: string[] = [];
    const old = gate.run(() => { order.push("old"); return provider.promise; }, controller.signal, true);
    const rejected = expect(old).rejects.toThrow("project changed");
    await flush();
    controller.abort(new Error("project changed"));
    await rejected;
    const next = gate.run(async () => { order.push("new"); return "new"; }, new AbortController().signal);
    await flush();
    expect(order).toEqual(["old"]);
    provider.resolve("late old result");
    expect(await next).toBe("new");
    expect(order).toEqual(["old", "new"]);
  });

  it("removes aborted waiters before they can reach the backend", async () => {
    const gate = createKnowledgeJudgeGate(), provider = deferred<void>();
    const active = gate.run(() => provider.promise, new AbortController().signal);
    await flush();
    const cancelled = new AbortController();
    let invoked = false;
    const waiting = gate.run(async () => { invoked = true; }, cancelled.signal);
    const rejected = expect(waiting).rejects.toThrow("cancelled");
    cancelled.abort(new Error("cancelled"));
    await rejected;
    provider.resolve();
    await active;
    await flush();
    expect(invoked).toBe(false);
  });

  it("reserves idle optional work atomically and never queues it behind active or waiting work", async () => {
    const gate = createKnowledgeJudgeGate(), write = deferred<string>();
    const order: string[] = [], signal = new AbortController().signal;
    let rejectedOptionalRan = false;
    const optional = gate.tryRunIfIdle(() => { order.push("optional"); return write.promise; }, signal);
    expect(optional).toBeDefined();
    expect(order).toEqual([]);
    const manual = gate.run(async () => { order.push("manual"); return "manual"; }, signal);
    const denied = gate.tryRunIfIdle(async () => { rejectedOptionalRan = true; }, signal);
    expect(denied).toBeUndefined();
    await flush();
    expect(order).toEqual(["optional"]);
    write.resolve("written");
    expect(await optional).toBe("written");
    expect(await manual).toBe("manual");
    await flush();
    expect(order).toEqual(["optional", "manual"]);
    expect(rejectedOptionalRan).toBe(false);

    // A manual request has reserved the queue but its pump has not run yet.
    const queued = gate.run(async () => { order.push("queued"); }, signal);
    expect(gate.tryRunIfIdle(async () => { rejectedOptionalRan = true; }, signal)).toBeUndefined();
    await queued; await flush();
    const later = gate.tryRunIfIdle(async () => { order.push("later optional"); return "done"; }, signal);
    expect(later).toBeDefined();
    expect(await later).toBe("done");
    await flush();
    expect(order).toEqual(["optional", "manual", "queued", "later optional"]);
    expect(rejectedOptionalRan).toBe(false);
  });

});
