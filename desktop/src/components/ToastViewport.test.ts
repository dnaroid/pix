// @ts-expect-error Node fs import in Vitest runner
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Desktop toast notifications", () => {
  it("mounts one toast stack and a status-bar notification center", () => {
    expect(read("../App.svelte")).toContain("<ToastViewport />");
    expect(read("../App.svelte")).toContain("toasts.setReporter(diagnosticLogger.report)");
    expect(read("./StatusBar.svelte")).toContain("<NotificationCenter />");
    const viewport = read("./ToastViewport.svelte");
    expect(viewport).toContain('role={toast.level === "error" ? "alert" : "status"}');
    expect(viewport).toContain("store.pause()");
    expect(viewport).toContain('aria-label="Dismiss notification"');
  });

  it("keeps one-shot action results out of inline panel status lines", () => {
    expect(read("./GitPanel.svelte")).not.toContain("workflow.notice");
    expect(read("./ClaudeAccountSwitcher.svelte")).not.toContain("Saved · limits cached");
    expect(read("./WorkspaceSidebarTaskQuickAdd.svelte")).not.toMatch(/\{notice\}/);
    expect(read("../app/desktop-project-services.ts")).toContain('source: "Git"');
  });
});
