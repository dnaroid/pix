import { describe, expect, it } from "vitest";
import composer from "./PromptComposer.svelte?raw";
import surface from "./DesktopWorkbenchSurface.svelte?raw";
import group from "./TranscriptActivityGroup.svelte?raw";
import activity from "./ComposerActivity.svelte?raw";
import activityRow from "./PromptComposerActivityRow.svelte?raw";
import controls from "./PromptComposerControls.svelte?raw";
import transcript from "./TranscriptPane.svelte?raw";

describe("pinned composer activity wiring", () => {
  it("aligns the entire conversation dock with the transcript column without constraining task editors", () => {
    const column = "mx-auto w-full max-w-4xl px-6";
    expect(transcript).toContain(column);
    expect(transcript).toContain("max-[760px]:px-3");
    expect(composer).toContain(`editorMode ? "" : "relative ${column} max-[760px]:px-3"`);
    expect(composer.indexOf(column)).toBeLessThan(composer.indexOf("<PromptComposerActivityRow"));
    expect(composer).not.toContain("relative bg-panel px-3 py-2");
    expect(surface).toContain('style:padding-right={`${transcriptScrollbarGutter}px`}');
    expect(surface).toContain("return observeTranscriptScrollbarGutter(pane,");
  });

  it("lives inside the composer dock before its form, not in the scrolling transcript", () => {
    expect(composer).toContain("{#if !editorMode}");
    expect(composer).toContain("{#key activeSessionId}");
    expect(composer.indexOf("<PromptComposerActivityRow")).toBeLessThan(composer.indexOf("<form"));
    expect(surface).toMatch(/row-start-3[^]*<PromptComposer[^]*\{#snippet queuedMessages\(\)\}[^]*<QueuedMessagesPanel/);
    const queuedMessages = composer.indexOf("{@render queuedMessages?.()}");
    expect(queuedMessages).toBeGreaterThan(composer.indexOf("<PromptComposerActivityRow"));
    expect(queuedMessages).toBeLessThan(composer.indexOf("<form"));
    expect(group).not.toContain("ComposerActivity");
  });

  it("places run controls beside status, outside message controls and the live region", () => {
    expect(activityRow).toContain("data-composer-activity-row");
    expect(activityRow).toContain("<ComposerActivity {activity} />");
    expect(activityRow).toContain('class="ml-auto grid w-23 shrink-0 grid-cols-3 items-center gap-1" data-agent-controls');
    expect(activityRow).toContain("onclick={onPause}");
    expect(activityRow).toContain("onclick={onCancel}");
    expect(activityRow).toContain("onclick={onContinue}");
    expect(activityRow).toContain('disabled={agentControlState === "pause-requested" || agentControlState === "resuming"}');
    expect(composer).toContain("showControls={!questionMode}");
    expect(activity).toContain("min-w-0 flex-1");
    expect(activity).not.toContain("<button");
    expect(controls).not.toMatch(/onPause|onCancel|onContinue|agentControlState/);
    expect(controls).toContain('aria-label={promptEnhancing ? "Improving prompt" : submitLabel ?? (promptRunning ? "Queue message" : "Send message")}');
  });

  it("announces changes neutrally and respects reduced motion", () => {
    expect(activity).toContain('role="status"');
    expect(activity).toContain("onDestroy(() => hold.dispose())");
    expect(activity).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.activity-label\s*\{[^}]*animation: activity-sweep/);
    expect(activity).not.toMatch(/Completed|Failed|text-destructive/);
    expect(activity).not.toContain("moreCount");
    expect(activity).toContain('class="activity-label min-w-0 truncate" title={visible.action}');
  });
});
