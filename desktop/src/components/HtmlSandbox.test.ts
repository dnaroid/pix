import { describe, expect, it } from "vitest";
import source from "./HtmlSandbox.svelte?raw";
import transcriptSource from "./TranscriptPane.svelte?raw";

describe("HTML sandbox automatic startup wiring", () => {
  it("excludes sandbox messages from offscreen rendering skips without disabling ordinary-message optimization", () => {
    expect(source).toContain("data-html-sandbox");
    expect(transcriptSource).toContain(`.transcript-entry:not(:has(:global([data-html-sandbox]))) {
    content-visibility: auto;
    contain-intrinsic-size: auto 120px;`);
    expect(transcriptSource).not.toContain(".transcript-entry {\n    content-visibility: auto;");
  });

  it("starts on source changes without tracking runtime state and cancels on cleanup", () => {
    expect(source).toContain('import { createSandboxAutorun } from "../lib/html-sandbox-autorun.svelte"');
    expect(source).toContain("createSandboxAutorun(() => source, (html) => { void start(html); }, stop);");
    expect(source).not.toContain("mountedSource");
    expect(source).not.toContain("It runs only when you choose Run");
  });

  it("keeps stop and manual restart available without passing click events as source", () => {
    expect(source).toContain('onclick={() => { stop(); status = ""; }}');
    expect(source).toContain("onclick={() => start()}");
    expect(source).not.toContain("onclick={start}");
    expect(source).toContain("{#if !loading}");
  });
});
