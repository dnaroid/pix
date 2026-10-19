import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import DesktopTitlebar from "./DesktopTitlebar.svelte";
import type { DesktopBuildStatus } from "../app/desktop-watch-restart.svelte";

function titlebar(buildStatus: DesktopBuildStatus, restartAvailable = false, restartPending = false) {
  return render(DesktopTitlebar, { props: {
    isMacOS: true, buildStatus, restartAvailable, restartPending,
    onRestart: () => {}, projectSwitcher: null, selector: null,
    workbench: {
      onReorder: () => {},
      tabs: [], activeId: null, canCreateSession: false,
      onSelect: () => {}, onClose: () => true, onCreateSession: () => {},
    },
  } }).body;
}

function restartButton(html: string) {
  return html.match(/<button\b[^>]*title="[^"]*(?:build|Build|Restart)[^"]*"[^>]*>[\s\S]*?<\/button>/g) ?? [];
}

describe("DesktopTitlebar combined build/restart action", () => {
  it("hides the action without a build or a ready artifact", () => {
    expect(restartButton(titlebar("idle"))).toHaveLength(0);
  });

  it.each(["queued", "building", "failed", "idle"] as const)("keeps one restartable control when %s", (status) => {
    const buttons = restartButton(titlebar(status, true));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).not.toMatch(/\sdisabled(?:\s|=|>)/);
    expect(buttons[0]).toContain("Restart Desktop to use the newly built version");
    expect(buttons[0]).toContain("h-6 w-6");
    expect(buttons[0]).toContain("bg-tool-error/10 text-tool-error");
    expect(buttons[0]).not.toContain("bg-primary");
    if (status === "building") expect(buttons[0]).toContain("motion-safe:animate-spin");
  });

  it.each(["queued", "building", "failed"] as const)("shows passive %s state in the same slot without a ready artifact", (status) => {
    const buttons = restartButton(titlebar(status));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatch(/\sdisabled(?:\s|=|>)/);
    expect(buttons[0]).not.toContain("Restart Desktop");
  });

  it("replaces build state with pending restart and restores it on cancellation", () => {
    const pending = restartButton(titlebar("building", true, true))[0]!;
    expect(pending).toMatch(/\sdisabled(?:\s|=|>)/);
    expect(pending).toContain("Restarting Desktop");
    expect(pending).toContain("motion-safe:animate-spin");
    expect(pending).not.toContain("Building new version");
    const cancelled = restartButton(titlebar("idle", true, false))[0]!;
    expect(cancelled).not.toMatch(/\sdisabled(?:\s|=|>)/);
    expect(cancelled).not.toContain("animate-spin");
  });
});
