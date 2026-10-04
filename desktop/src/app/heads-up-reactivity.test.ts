import source from "./heads-up.svelte.ts?raw";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { expect, it } from "vitest";
// @ts-expect-error Internal client runtime has no public declarations; this test
// executes real compiled runes rather than SSR's intentionally inert state.
import * as client from "svelte/internal/client";
import * as parser from "../lib/heads-up";
import * as contract from "../../../src/bundled-extensions/heads-up/contract";
import type { createHeadsUpStore } from "./heads-up.svelte";

it("navigation alone reactively updates the visible card and status without a snapshot or timer", () => {
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const compiled = compileModule(javascript, { filename: "heads-up.svelte.js", generate: "client" }).js.code;
  const commonjs = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { createHeadsUpStore?: typeof createHeadsUpStore } = {};
  const dependencies: Record<string, unknown> = {
    "svelte/internal/client": client,
    "../lib/heads-up": parser,
    "../../../src/bundled-extensions/heads-up/contract": contract,
  };
  new Function("require", "exports", commonjs)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  const store = exports.createHeadsUpStore!({ client: () => null, runtimeReady: () => true, reportError: () => {} });
  const now = Date.now();
  const a = { id: "a", title: "A", consequence: "A", evidence: [{ id: "e", text: "Evidence" }], createdAt: now, expiresAt: now + 30_000 };
  const b = { ...a, id: "b", title: "B" };
  store.handleSessionState({ sessionId: "s", channel: "heads-up", data: {
    version: 1, instanceId: "runtime", revision: 1, enabled: true, model: "p/m", phase: "idle",
    checks: 1, inputTokens: 1, outputTokens: 1, notice: a, notices: [a, b],
  } });
  const observed: string[] = [];
  const stop = client.effect_root(() => client.render_effect(() => {
    observed.push(`${store.notice("s")?.id}:${store.state("s")?.notice?.id}`);
  }));
  try {
    expect(observed).toEqual(["a:a"]);
    store.selectNotice("s", "a", 1, "runtime");
    client.flush();
    expect(observed).toEqual(["a:a", "b:b"]);
    store.handleSessionState({ sessionId: "s", channel: "heads-up", data: {
      version: 1, instanceId: "runtime", revision: 2, enabled: true, model: "p/m", phase: "idle",
      checks: 1, inputTokens: 1, outputTokens: 1, notice: null, notices: [], awaitingReview: true,
    } });
    client.flush();
    expect(observed).toEqual(["a:a", "b:b", "undefined:undefined"]);
  } finally { stop(); store.reset(); }
});
