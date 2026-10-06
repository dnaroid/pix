import { afterEach, describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createLspPanel } from "../src/lsp/renderer";
import type { LspRuntimeSnapshot } from "../src/lsp/runtime-control";

const panels: Array<ReturnType<typeof createLspPanel>> = [];
afterEach(() => { for (const panel of panels.splice(0)) panel.dispose(); });
const settled = () => Bun.sleep(0);
const snapshot: LspRuntimeSnapshot = { servers: [
  { id: "ts", root: "/project", state: "running", pid: 122 },
  { id: "python", root: "/project/sub", state: "running", pid: 123 },
], warnings: [] };

describe("LSP TUI panel", () => {
  test("opens read-only and ignores former process control keys", async () => {
    let calls = 0;
    const panel = createLspPanel(async () => { calls++; return snapshot; }, () => {}, () => {});
    panels.push(panel);
    await settled();
    expect(calls).toBe(1);
    panel.handleInput!("\x1b[B");
    panel.handleInput!("x");
    await settled();
    panel.handleInput!("s");
    await settled();
    panel.handleInput!("r");
    await settled();
    panel.handleInput!("t");
    expect(calls).toBe(1);
    panel.handleInput!("u");
    await settled();
    expect(calls).toBe(2);
    expect(panel.render(80).join("\n")).toContain("PID 123");
  });

  test("warnings and missing trust remain monitoring-only", async () => {
    let calls = 0;
    const results: undefined[] = [];
    const panel = createLspPanel(async () => { calls++; return { ...snapshot, warnings: ["Untrusted project configuration"], trustRequired: true }; }, () => {}, (result) => results.push(result));
    panels.push(panel);
    await settled();
    panel.handleInput!("s"); panel.handleInput!("r"); panel.handleInput!("x");
    await settled();
    expect(calls).toBe(1);
    panel.handleInput!("t");
    expect(results).toEqual([]);
    panel.handleInput!("u");
    await settled();
    expect(calls).toBe(2);
    expect(panel.render(120).join("\n")).toContain("Untrusted project configuration");
    panel.handleInput!("\x1b");
    expect(results).toEqual([undefined]);
  });

  test("an empty runtime explains edit-triggered startup rather than listing configs", async () => {
    const panel = createLspPanel(async () => ({ servers: [], warnings: [] }), () => {}, () => {});
    panels.push(panel);
    await settled();
    const text = panel.render(120).join("\n");
    expect(text).toContain("No running language servers");
    expect(text).toContain("Started by file edits");
    expect(text).not.toContain("s start");
  });

  test("closing during a request suppresses redraw/completion and duplicate input", async () => {
    let resolve!: (snapshot: LspRuntimeSnapshot) => void;
    let redraws = 0;
    const results: undefined[] = [];
    let calls = 0;
    const panel = createLspPanel(() => { calls++; return new Promise((done) => { resolve = done; }); }, () => { redraws++; }, (result) => results.push(result));
    panels.push(panel);
    panel.handleInput!("u");
    expect(calls).toBe(1);
    panel.handleInput!("\x1b");
    const before = redraws;
    resolve(snapshot);
    await settled();
    expect(redraws).toBe(before);
    expect(results).toEqual([undefined]);
    panel.handleInput!("t");
    expect(results).toEqual([undefined]);
  });

  test("renders failures and untrusted text safely in narrow terminals", async () => {
    const panel = createLspPanel(async () => ({ servers: [{ id: "\x1b[2Jevil", root: "/path\nwith\tcontrols", state: "failed", error: "spawn failed" }], warnings: [] }), () => {}, () => {});
    panels.push(panel);
    await settled();
    expect(panel.render(80).join("\n")).toContain("spawn failed");
    for (const line of panel.render(12)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(12);
      expect(stripTerminalSequences(line)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(line).not.toContain("\x1b[2J");
    }
  });
});
