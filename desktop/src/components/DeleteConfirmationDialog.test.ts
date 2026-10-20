import { describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import DeleteConfirmationDialog from "./DeleteConfirmationDialog.svelte";
import source from "./DeleteConfirmationDialog.svelte?raw";
import host from "./DeleteConfirmationHost.svelte?raw";
import sidebar from "./WorkspaceSidebar.svelte?raw";
import logs from "./LogsPanel.svelte?raw";

describe("shared deletion dialog", () => {
  it("renders action-specific text escaped with shared destructive styling", () => {
    const html = render(DeleteConfirmationDialog, { props: {
      title: "Delete file?", message: "Delete <example.txt>?", onconfirm: vi.fn(), oncancel: vi.fn(),
    } }).body;
    expect(html).toContain("<dialog");
    expect(html).toContain("Delete file?");
    expect(html).toContain("Delete &lt;example.txt>?");
    expect(html).not.toContain("<example.txt>");
    expect(html.indexOf(">Cancel</button>")).toBeLessThan(html.indexOf(">Delete</button>"));
    expect(html).toContain("bg-destructive/10");
    expect(html).toContain("aria-labelledby=");
    expect(html).toContain("aria-describedby=");
  });

  it("supports cleanup labels and busy guards", () => {
    const html = render(DeleteConfirmationDialog, { props: {
      title: "Clear?", message: "All projects", okLabel: "Clear all logs", disabled: true,
      onconfirm: vi.fn(), oncancel: vi.fn(),
    } }).body;
    expect(html).toMatch(/disabled[^>]*>Clear all logs<\/button>/);
    expect(source).toContain("if (!disabled) onconfirm()");
  });

  it("shares the modal focus lifecycle, safe default and Escape cancellation", () => {
    expect(source).toContain("activateModalDialog(dialog, () => cancelButton)");
    expect(source).toContain("event.preventDefault(); oncancel()");
    expect(source).toContain("diagnostics.report(error); oncancel()");
    expect(source).not.toContain('type="submit"');
    expect(host).toContain("onMount(() => attachDeletionConfirmation");
    expect(host).toContain("{#key request}");
  });

  it("replaces task and log one-off confirmations with the same component", () => {
    for (const component of [sidebar, logs, host]) expect(component).toContain("<DeleteConfirmationDialog");
    expect(sidebar).not.toContain('aria-label="Delete task"');
    expect(logs).not.toContain("<dialog");
    expect(sidebar).toContain("workspace !== deleteTaskWorkspace");
  });
});
