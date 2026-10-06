import { describe, expect, test } from "bun:test";
import { LSP_IDLE_TIMEOUT_MS, LspIdleCleanup } from "../src/lsp/idle-cleanup";
import { ManualLspClock } from "./helpers/manual-lsp-clock";

describe("LSP idle cleanup clock", () => {
  test("defaults to fifteen minutes, expires once, and resets on actual activity", () => {
    const clock = new ManualLspClock();
    const expired: object[] = [];
    const idle = new LspIdleCleanup((client) => expired.push(client), { schedule: clock.schedule });
    const client = {};
    idle.begin(client)();
    expect(LSP_IDLE_TIMEOUT_MS).toBe(900_000);
    clock.advance(LSP_IDLE_TIMEOUT_MS - 1);
    expect(expired).toHaveLength(0);
    const finish = idle.begin(client);
    clock.advance(LSP_IDLE_TIMEOUT_MS * 2);
    expect(expired).toHaveLength(0);
    finish(); finish();
    expect(clock.pending).toBe(1);
    clock.advance(LSP_IDLE_TIMEOUT_MS);
    expect(expired).toEqual([client]);
    clock.advance(LSP_IDLE_TIMEOUT_MS);
    expect(expired).toEqual([client]);
  });

  test("overlapping owners protect requests and cancelled queued timers cannot stop new work", () => {
    const clock = new ManualLspClock();
    const expired: object[] = [];
    const idle = new LspIdleCleanup((client) => expired.push(client), { schedule: clock.schedule });
    const client = {};
    idle.begin(client)();
    const queued = clock.tasks[0];
    const first = idle.begin(client);
    const second = idle.begin(client);
    queued.callback();
    first();
    clock.advance(LSP_IDLE_TIMEOUT_MS * 2);
    expect(clock.pending).toBe(0);
    expect(expired).toHaveLength(0);
    second();
    queued.callback();
    expect(expired).toHaveLength(0);
    clock.advance(LSP_IDLE_TIMEOUT_MS);
    expect(expired).toEqual([client]);
  });

  test("different clients expire independently and teardown fences stale release/callbacks", () => {
    const clock = new ManualLspClock();
    const expired: object[] = [];
    const idle = new LspIdleCleanup((client) => expired.push(client), { schedule: clock.schedule });
    const a = {}, b = {};
    idle.begin(a)();
    const finishB = idle.begin(b);
    clock.advance(LSP_IDLE_TIMEOUT_MS);
    expect(expired).toEqual([a]);
    idle.forget(b); finishB();
    expect(clock.pending).toBe(0);
    idle.begin(a)();
    const queued = clock.tasks[clock.tasks.length - 1];
    const late = idle.begin(b);
    idle.clear(); late(); queued.callback();
    expect(clock.pending).toBe(0);
    expect(expired).toEqual([a]);
  });
});
