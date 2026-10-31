import { describe, expect, it } from "vitest";
import { createTerminalInitialWriteGate } from "./terminal-initial-write-gate";
import terminalSource from "./TerminalView.svelte?raw";

describe("terminal initial write gate", () => {
  it("writes the captured snapshot before live chunks that arrived before the initial frame, exactly once", () => {
    const written: string[] = [];
    const gate = createTerminalInitialWriteGate((data) => written.push(data));

    // The snapshot is captured at attach time; the output prop then grows with these chunks.
    gate.write("live-1");
    gate.write("");
    gate.write("live-2");
    expect(written).toEqual([]);

    gate.open("snapshot");
    gate.open("snapshot-with-live-1-live-2");
    gate.write("live-3");

    expect(written).toEqual(["snapshot", "live-1", "live-2", "live-3"]);
  });

  it("skips an empty snapshot but still flushes queued live output", () => {
    const written: string[] = [];
    const gate = createTerminalInitialWriteGate((data) => written.push(data));
    gate.write("live");
    gate.open("");
    expect(written).toEqual(["live"]);
  });

  it("is wired into TerminalView with an untracked snapshot and reactive terminal state", () => {
    expect(terminalSource).toContain("let terminal = $state.raw<Terminal | undefined>()");
    expect(terminalSource).toContain("untrack(() => initialContent)");
    expect(terminalSource).toContain("gate.open(initialSnapshot)");
    expect(terminalSource).not.toContain("next.write(initialContent)");
    // The option effect must track running/convertEol even on its first (pre-attach) run.
    const optionsEffect = terminalSource.slice(terminalSource.indexOf("const disableStdin = !running;"));
    expect(optionsEffect.indexOf("const nextConvertEol = convertEol;")).toBeLessThan(optionsEffect.indexOf("if (!currentTerminal) return;"));
    expect(optionsEffect).toContain("currentTerminal.options.disableStdin = disableStdin;");
  });
});
