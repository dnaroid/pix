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
    expect(source).toContain('{#if item.source === "auto" || item.source === "sdk-follow-up"}');
    expect(source).toContain('<Pause');
    expect(source).toContain('<Hourglass');
    expect(source).toContain('aria-label="Send queued message immediately"');
    expect(source).toContain('aria-label="Edit queued message"');
    expect(source).toContain('aria-label="Cancel queued message"');
  });
});
