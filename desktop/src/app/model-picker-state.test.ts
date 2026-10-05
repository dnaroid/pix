import { describe, expect, it, vi } from "vitest";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
// @ts-expect-error Internal client runtime has no public declarations.
import * as client from "svelte/internal/client";
import source from "./model-picker-state.svelte.ts?raw";
import type { ModelConfigOptions } from "./model-config-options";
import type { ModelDraftConfig } from "./model-draft-config.svelte";
import type { createModelPickerState } from "./model-picker-state.svelte";

// Execute client runes, including owner-loss effects, not SSR's inert state.
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
const compiled = compileModule(javascript, { filename: "model-picker-state.svelte.js", generate: "client" }).js.code;
const commonjs = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
const exports: { createModelPickerState?: typeof createModelPickerState } = {};
new Function("require", "exports", commonjs)((name: string) => {
  if (name !== "svelte/internal/client") throw new Error(`Unexpected dependency: ${name}`);
  return client;
}, exports);

function setup(load = async () => {}) {
  const owner = client.state("session");
  const options = {
    draftSessionTabActive: () => false,
    activeSessionId: () => client.get(owner),
    activeSessionRuntimeReady: () => true,
    operationRunning: () => false,
    changingConfig: () => null,
    closeCommandPicker: vi.fn(),
    preferences: { waitForVisibleModelsSave: async () => {}, load },
  } as unknown as ModelConfigOptions;
  let picker!: ReturnType<typeof createModelPickerState>;
  const dispose = client.effect_root(() => {
    picker = exports.createModelPickerState!(options, {
      refreshRoutingAvailability: async () => {},
    } as unknown as ModelDraftConfig);
  });
  return { picker, dispose, setOwner: (id: string) => { client.set(owner, id); client.flush(); } };
}

describe("model picker activation ownership", () => {
  it("toggles an open picker closed on repeat activation", async () => {
    const { picker, dispose } = setup();
    try {
      await picker.show();
      expect(picker.open).toBe(true);
      await picker.show();
      expect(picker.open).toBe(false);
      expect(picker.sessionId).toBeNull();
    } finally { dispose(); }
  });

  it("cancels a pending activation and ignores its late completion", async () => {
    let resolve!: () => void;
    const { picker, dispose } = setup(() => new Promise<void>((done) => resolve = done));
    try {
      const first = picker.show();
      await Promise.resolve();
      await Promise.resolve();
      await picker.show();
      resolve();
      await first;
      expect(picker.open).toBe(false);
      expect(picker.sessionId).toBeNull();
    } finally { dispose(); }
  });

  it("closes on owner change and cannot reopen from the old pending load", async () => {
    let resolve!: () => void;
    const { picker, dispose, setOwner } = setup(() => new Promise<void>((done) => resolve = done));
    try {
      const opening = picker.show();
      await Promise.resolve();
      await Promise.resolve();
      setOwner("other-session");
      resolve();
      await opening;
      expect(picker.open).toBe(false);
      expect(picker.sessionId).toBeNull();
    } finally { dispose(); }
  });

  it("can retry opening after a rejected preference load", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("load failed")).mockResolvedValue(undefined);
    const { picker, dispose } = setup(load);
    try {
      await expect(picker.show()).rejects.toThrow("load failed");
      await picker.show();
      expect(picker.open).toBe(true);
    } finally { dispose(); }
  });
});
