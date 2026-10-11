import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSearchIndexCommand } from "../src/project-search/index-command.js";
import { INDEX_SOURCES, type IndexResult, type IndexSource } from "../src/project-search/index-runner.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  let command: any;
  const events = new Map<string, () => Promise<void>>();
  const notifications: string[] = [], statuses: (string | undefined)[] = [];
  const runs: { source: IndexSource; signal: AbortSignal; finish: (value: IndexResult) => void; fail: () => void }[] = [];
  let reads = 0;
  const pi = { registerCommand: (name: string, value: unknown) => { expect(name).toBe("search-index"); command = value; },
    on: (name: string, callback: () => Promise<void>) => events.set(name, callback) } as unknown as ExtensionAPI;
  const ctx = { cwd: "/fixture", ui: { notify: (text: string) => notifications.push(text),
    setStatus: (_key: string, text: string | undefined) => statuses.push(text) } } as unknown as ExtensionContext;
  registerSearchIndexCommand(pi, {
    run: (_root, source, signal) => new Promise((resolve, reject) => runs.push({ source, signal, finish: resolve, fail: () => reject(new Error("SECRET")) })),
    status: async () => { reads++; return ["code: 2 stored items, 1 stored vectors"]; },
  });
  return { command, events, notifications, statuses, runs, get reads() { return reads; },
    invoke: (args: string) => command.handler(args, ctx) as Promise<void> };
}

test("all starts exactly five independent sources; status is diagnostic only", async () => {
  const f = fixture();
  await f.invoke("all");
  expect(f.runs.map(run => run.source)).toEqual([...INDEX_SOURCES]);
  await f.invoke("status");
  expect(f.reads).toBe(1);
  expect(f.runs).toHaveLength(5);
  expect(f.notifications.at(-1)).toContain("Stored counts are not freshness/coverage");
  f.runs.forEach(run => run.finish({ complete: true, indexed: 7 }));
  await tick();
  expect(f.notifications.filter(text => text.includes("complete (7 indexed)"))).toHaveLength(5);
  expect(f.statuses.at(-1)).toBeUndefined();
});

test("cancel is source-local and keeps duplicate starts blocked until actual settlement", async () => {
  const f = fixture();
  await f.invoke("code"); await f.invoke("knowledge");
  await f.invoke("cancel code"); await f.invoke("code");
  expect(f.runs).toHaveLength(2);
  expect(f.runs[0]!.signal.aborted).toBe(true);
  expect(f.runs[1]!.signal.aborted).toBe(false);
  f.runs[0]!.finish({ complete: true });
  await tick();
  expect(f.notifications.at(-1)).toContain("code: cancelled");
  await f.invoke("code"); expect(f.runs).toHaveLength(3);
  await f.invoke("cancel");
  expect(f.runs.every(run => run.signal.aborted)).toBe(true);
  f.runs.slice(1).forEach(run => run.finish({ complete: false }));
  await tick();
});

test("shutdown waits for transports, suppresses late UI and fences pending commands", async () => {
  const f = fixture();
  await f.invoke("sessions");
  let settled = false;
  const shutdown = f.events.get("session_shutdown")!().then(() => settled = true);
  const waiting = f.invoke("tasks");
  const start = f.events.get("session_start")!();
  await tick();
  expect(settled).toBe(false);
  expect(f.runs[0]!.signal.aborted).toBe(true);
  const before = f.notifications.length;
  f.runs[0]!.finish({ complete: true });
  await Promise.all([shutdown, start, waiting]);
  expect(f.notifications).toHaveLength(before);
  expect(f.runs).toHaveLength(1);
  expect(f.statuses.at(-1)).toBeUndefined();
  await f.invoke("tasks");
  expect(f.runs).toHaveLength(2);
  f.runs[1]!.finish({ complete: true });
  await tick();
});

test("invalid commands do not start work and autocomplete excludes settings", async () => {
  const f = fixture();
  for (const input of ["settings", "code extra", "cancel settings", "cancel all extra"]) await f.invoke(input);
  expect(f.runs).toHaveLength(0); expect(f.reads).toBe(0);
  expect(f.command.getArgumentCompletions("").map((entry: any) => entry.value)).not.toContain("settings");
  expect(f.command.getArgumentCompletions("cancel co").map((entry: any) => entry.value)).toEqual(["cancel code", "cancel commits"]);
});

test("one failure does not cancel siblings or expose provider errors", async () => {
  const f = fixture();
  await f.invoke("all"); f.runs[0]!.fail();
  await tick();
  expect(f.notifications.join(" ")).not.toContain("SECRET");
  expect(f.runs.slice(1).every(run => !run.signal.aborted)).toBe(true);
  f.runs.slice(1).forEach(run => run.finish({ complete: false, message: "Configure provider first." }));
  await tick();
  expect(f.notifications.filter(text => text.includes(": partial."))).toHaveLength(4);
});
