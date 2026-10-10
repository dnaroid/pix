import { describe, expect, it, vi } from "vitest";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
// @ts-expect-error Internal client runtime has no public declarations.
import * as client from "svelte/internal/client";
import source from "./model-config.svelte.ts?raw";
import type { ModelConfigOptions } from "./model-config-options";
import type { createModelConfig } from "./model-config.svelte";

describe("draft default startup", () => {
  it("reads local preferences without waiting for ACP and warms sessionless defaults once ready", () => {
    const ready = client.state(false);
    const load = vi.fn(async () => {});
    const refresh = vi.fn(async () => {});
    const reset = vi.fn();
    const draft = { refresh, reset, displayConfigOptions: [] };
    const javascript = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    }).outputText;
    const compiled = compileModule(javascript, { filename: "model-config.svelte.js", generate: "client" }).js.code;
    const commonjs = ts.transpileModule(compiled, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports: { createModelConfig?: typeof createModelConfig } = {};
    const dependencies: Record<string, unknown> = {
      "svelte/internal/client": client,
      svelte: { untrack: client.untrack },
      "./model-draft-config.svelte": { createModelDraftConfig: () => draft },
      "./model-picker-state.svelte": { createModelPickerState: () => ({}) },
      "./model-config-actions": { createModelConfigActions: () => ({}) },
    };
    new Function("require", "exports", commonjs)((name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    }, exports);
    const options = {
      preferences: { load }, client: () => ({}), workspace: () => "/project",
      statusReady: () => client.get(ready),
    } as unknown as ModelConfigOptions;
    const dispose = client.effect_root(() => { exports.createModelConfig!(options); });
    try {
      client.flush();
      expect(load).toHaveBeenCalledOnce();
      expect(refresh).not.toHaveBeenCalled();
      client.set(ready, true);
      client.flush();
      expect(refresh).toHaveBeenCalledOnce();
      expect(load).toHaveBeenCalledOnce();
    } finally { dispose(); }
    expect(reset).toHaveBeenCalledOnce();
  });
});
