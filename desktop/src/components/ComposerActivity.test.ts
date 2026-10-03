import { describe, expect, it } from "vitest";
import composer from "./PromptComposer.svelte?raw";
import surface from "./DesktopWorkbenchSurface.svelte?raw";
import group from "./TranscriptActivityGroup.svelte?raw";
import activity from "./ComposerActivity.svelte?raw";
import transcript from "./TranscriptPane.svelte?raw";

describe("pinned composer activity wiring", () => {
  it("aligns the entire conversation dock with the transcript column without constraining task editors", () => {
    const column = "mx-auto w-full max-w-4xl px-6";
    expect(transcript).toContain(column);
    expect(transcript).toContain("max-[760px]:px-3");
    expect(composer).toContain(`editorMode ? "" : "relative ${column} max-[760px]:px-3"`);
    expect(composer.indexOf(column)).toBeLessThan(composer.indexOf("<ComposerActivity {activity} />"));
    expect(composer).not.toContain("relative bg-panel px-3 py-2");
    expect(surface).toContain('style:padding-right={`${transcriptScrollbarGutter}px`}');
    expect(surface).toContain("return observeTranscriptScrollbarGutter(pane,");
  });

  it("lives inside the composer dock before its form, not in the scrolling transcript", () => {
    expect(composer).toContain("{#if activity && !editorMode}");
    expect(composer).toContain("{#key activeSessionId}");
    expect(composer.indexOf("<ComposerActivity {activity} />")).toBeLessThan(composer.indexOf("<form"));
    expect(surface).toMatch(/row-start-3[^]*<PromptComposer[^]*\{#snippet queuedMessages\(\)\}[^]*<QueuedMessagesPanel/);
    const queuedMessages = composer.indexOf("{@render queuedMessages?.()}");
    expect(queuedMessages).toBeGreaterThan(composer.indexOf("<ComposerActivity {activity} />"));
    expect(queuedMessages).toBeLessThan(composer.indexOf("<form"));
    expect(group).not.toContain("ComposerActivity");
  });

  it("announces changes neutrally and respects reduced motion", () => {
    expect(activity).toContain('role="status"');
    expect(activity).toContain("onDestroy(() => hold.dispose())");
    expect(activity).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.activity-label\s*\{[^}]*animation: activity-sweep/);
    expect(activity).not.toMatch(/Completed|Failed|text-destructive/);
  });
});
