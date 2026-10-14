import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSearchIndexCommand } from "../src/project-search/index-command.js";
import type { IndexResult, IndexSource } from "../src/project-search/index-runner.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("manual indexing reports only incomplete and failed sources, not cancellation or private errors", async () => {
  const sinkSymbol = Symbol.for("pix.diagnostics.sink");
  const hostSymbol = Symbol.for("pix.host.runtime");
  const globals = globalThis as Record<symbol, unknown>;
  const previousSink = globals[sinkSymbol], previousHost = globals[hostSymbol];
  const records: Array<{ level: string; event: string; details: Record<string, unknown> }> = [];
  globals[hostSymbol] = true;
  globals[sinkSymbol] = (level: string, event: string, details: Record<string, unknown>) =>
    records.push({ level, event, details });
  try {
    let command: any;
    const runs: Array<{ source: IndexSource; signal: AbortSignal;
      finish: (value: IndexResult) => void; fail: (reason: unknown) => void }> = [];
    const pi = {
      on() {},
      registerCommand(_name: string, value: unknown) { command = value; },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/test/index", ui: { setStatus() {}, notify() { throw new Error("No chat notifications"); } },
    } as unknown as ExtensionContext;
    registerSearchIndexCommand(pi, {
      log: async () => {},
      run: (_root, source, signal) => new Promise((resolve, reject) =>
        runs.push({ source, signal, finish: resolve, fail: reject })),
    });
    await command.handler("all", ctx);
    expect(runs).toHaveLength(5);
    runs[0]!.finish({ complete: false, indexed: 2, message: "private provider error" });
    runs[1]!.fail(new Error("PRIVATE_API_TOKEN"));
    runs[2]!.finish({ complete: true, indexed: 3 });
    await command.handler("cancel tasks", ctx);
    runs[3]!.fail(new Error("PRIVATE_CANCELLED"));
    runs[4]!.finish({ complete: true });
    await tick();
    expect(records.map(({ event }) => event)).toEqual(["suite:index-partial", "suite:index-failed"]);
    expect(records[0]!.details).toMatchObject({ source: "code", indexed: 2 });
    expect(records[1]!.details).toMatchObject({ source: "knowledge", errorType: "Error" });
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
    expect(JSON.stringify(records)).not.toContain("provider error");
  } finally {
    if (previousSink === undefined) delete globals[sinkSymbol]; else globals[sinkSymbol] = previousSink;
    if (previousHost === undefined) delete globals[hostSymbol]; else globals[hostSymbol] = previousHost;
  }
});
