import { describe, expect, it } from "vitest";
import composer from "./PromptComposer.svelte?raw";
import surface from "./DesktopWorkbenchSurface.svelte?raw";
import group from "./TranscriptActivityGroup.svelte?raw";
import activity from "./ComposerActivity.svelte?raw";

describe("pinned composer activity wiring", () => {
  it("lives inside the composer dock before its form, not in the scrolling transcript", () => {
    expect(composer).toContain("{#if activity && !editorMode}");
    expect(composer).toContain("{#key activeSessionId}");
    expect(composer.indexOf("<ComposerActivity {activity} />")).toBeLessThan(composer.indexOf("<form"));
    expect(surface).toMatch(/row-start-3[^]*<QueuedMessagesPanel[^]*<PromptComposer/);
    expect(group).not.toContain("ComposerActivity");
  });

  it("announces changes neutrally and respects reduced motion", () => {
    expect(activity).toContain('role="status"');
    expect(activity).toContain("onDestroy(() => hold.dispose())");
    expect(activity).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.activity-label\s*\{[^}]*animation: activity-sweep/);
    expect(activity).not.toMatch(/Completed|Failed|text-destructive/);
  });
});
