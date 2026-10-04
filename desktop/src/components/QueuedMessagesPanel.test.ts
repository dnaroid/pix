import { describe, expect, it } from "vitest";
import source from "./QueuedMessagesPanel.svelte?raw";

describe("queued message presentation", () => {
  it("uses separate composer-style frames with a bounded scrolling stack", () => {
    expect(source).toContain('class="mb-2 flex max-h-44 flex-col gap-2 overflow-y-auto"');
    expect(source).toContain("rounded-md border border-input bg-panel-strong px-2 py-1.5");
    expect(source).not.toContain("border-b");
    expect(source).not.toContain("border-t");
  });

  it("keeps paused and steering status accessible without visible text badges", () => {
    expect(source).toContain('aria-label={label(item)}');
    expect(source).toContain('{#if item.source === "auto" || item.source === "sdk-follow-up" || item.source === "fork"}');
    expect(source).toContain('<Pause');
    expect(source).toContain('<Hourglass');
    expect(source).toContain('aria-label="Send queued message immediately"');
    expect(source).toContain('aria-label="Edit queued message"');
    expect(source).toContain('aria-label="Cancel queued message"');
  });

  it("distinguishes fork items and prevents sending them into the source", () => {
    expect(source).toContain('<GitFork');
    expect(source).toContain('if (item.source === "fork") return "fork"');
    expect(source).toContain('disabled={disabled || item.source === "fork"}');
  });

  it("distinguishes paused and waiting icons with quiet semantic color tiles", () => {
    expect(source).toContain('grid h-5 w-5 shrink-0 place-items-center rounded-sm bg-tool-info/10 text-tool-info');
    expect(source).toContain('grid h-5 w-5 shrink-0 place-items-center rounded-sm bg-tool-warning/10 text-tool-warning');
    expect(source).not.toContain('animate-');
  });
});
