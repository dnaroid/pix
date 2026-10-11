import source from "./html-sandbox-autorun.svelte.ts?raw";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { describe, expect, it } from "vitest";
// @ts-expect-error Execute compiled client runes rather than inert SSR state.
import * as client from "svelte/internal/client";
import type { createSandboxAutorun } from "./html-sandbox-autorun.svelte";

function loadAutorun(): typeof createSandboxAutorun {
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const compiled = compileModule(javascript, { filename: "html-sandbox-autorun.svelte.js", generate: "client" }).js.code;
  const commonjs = ts.transpileModule(compiled, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: { createSandboxAutorun?: typeof createSandboxAutorun } = {};
  const dependencies: Record<string, unknown> = {
    "svelte/internal/client": client,
    svelte: { untrack: client.untrack },
  };
  new Function("require", "exports", commonjs)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports.createSandboxAutorun!;
}

describe("HTML sandbox source-value ownership", () => {
  it("does not tear down an iframe for fresh segment objects with unchanged HTML", () => {
    const segment = client.state({ html: "<canvas></canvas>" });
    const calls: string[] = [];
    const autorun = loadAutorun();
    const dispose = client.effect_root(() => autorun(
      () => client.get(segment).html,
      (html) => calls.push(`start:${html}`),
      () => calls.push("stop"),
    ));
    try {
      client.flush();
      expect(calls).toEqual(["start:<canvas></canvas>"]);
      for (let index = 0; index < 3; index += 1) {
        client.set(segment, { html: "<canvas></canvas>" });
        client.flush();
      }
      expect(calls).toEqual(["start:<canvas></canvas>"]);
      client.set(segment, { html: "<form></form>" });
      client.flush();
      expect(calls).toEqual(["start:<canvas></canvas>", "stop", "start:<form></form>"]);
    } finally { dispose(); }
    expect(calls.at(-1)).toBe("stop");
  });

  it("does not restart a manually stopped run after unrelated runtime or wrapper updates", () => {
    const segment = client.state({ html: "<p>demo</p>" });
    const running = client.state(false);
    let starts = 0;
    let stops = 0;
    const autorun = loadAutorun();
    const dispose = client.effect_root(() => autorun(
      () => client.get(segment).html,
      () => { starts += 1; client.get(running); client.set(running, true); },
      () => { stops += 1; client.set(running, false); },
    ));
    try {
      client.flush();
      client.set(running, false);
      client.set(segment, { html: "<p>demo</p>" });
      client.flush();
      expect(starts).toBe(1);
      expect(stops).toBe(0);
      expect(client.get(running)).toBe(false);
    } finally { dispose(); }
    expect(stops).toBe(1);
  });
});
