import { describe, expect, it } from "vitest";
import bootstrapSource from "./DesktopBootstrapDialog.svelte?raw";

describe("DesktopBootstrapDialog", () => {
  it("keeps first-run setup visible on Escape and completes only through Continue", () => {
    expect(bootstrapSource).toContain("function retainUntilContinue(event: Event): void {");
    expect(bootstrapSource).toContain("event.preventDefault();");
    expect(bootstrapSource).toContain("oncancel={retainUntilContinue}");
    expect(bootstrapSource).not.toContain("oncancel={(event) => { event.preventDefault(); finish(); }}");
    expect(bootstrapSource).toContain("onclick={finish}");
    expect(bootstrapSource).toContain("disabled={busy !== null || saving}");
    expect(bootstrapSource).not.toContain("localStorage");
  });

  it("shows Claude Code and Antigravity status and labels the Codex import as the static API key", () => {
    expect(bootstrapSource).toContain("data-bootstrap-claude-code");
    expect(bootstrapSource).toContain("data-bootstrap-antigravity");
    expect(bootstrapSource).toContain("openTerminal(claudeLoginCommand())");
    expect(bootstrapSource).toContain("/antigravity-add-account");
    expect(bootstrapSource).toContain("Codex API key (OPENAI_API_KEY)");
    // Sign-in completes setup first so the modal does not cover the terminal.
    expect(bootstrapSource).toMatch(/if \(!openTerminal \|\| !\(await finish\(\)\)\) return;/u);
  });
});
