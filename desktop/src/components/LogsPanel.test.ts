import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import LogsPanel from "./LogsPanel.svelte";
import source from "./LogsPanel.svelte?raw";

describe("Logs panel controls", () => {
  it("renders newest records last and preserves reader intent across DOM updates", () => {
    const html = render(LogsPanel, { props: { workspace: "/project" } }).body;
    expect(html).toContain("newest last");
    expect(source).toContain("}).reverse())");
    expect(source).toContain("$effect.pre(");
    expect(source).toContain("tracker.capture()");
    expect(source).toContain("if (!cancelled) tracker.restore(position)");
    expect(source).toContain("scrollTracker?.handleScroll()");
    expect(source).toContain("data-event-id={entry.id}");
    expect(source).toContain("observer.disconnect()");
    expect(source).toContain("[overflow-anchor:none]");
  });

  it("uses a defined warning theme color and local display time without changing raw timestamps", () => {
    expect(source).toContain('class:text-tool-warning={entry.record.level === "warn"}');
    expect(source).toContain("{formatDiagnosticLogTime(entry.record.time)}");
    expect(source).toContain("datetime={entry.record.time} title={entry.record.time}");
    expect(source).toContain("JSON.stringify(entry.record, null, 2)");
  });

  it("renders both filter choices as Pix dropdowns and exposes clear all logs", () => {
    const html = render(LogsPanel, { props: { workspace: "/project" } }).body;
    expect(html).not.toMatch(/<select\b/u);
    expect(html.match(/aria-haspopup="listbox"/gu)).toHaveLength(2);
    expect(html).toContain('aria-label="Log level"');
    expect(html).toContain('aria-label="Log source"');
    expect(html).toContain('aria-label="Clear all logs"');
    expect(html).toContain("lucide-trash-2");
  });

  it("requires a Pix confirmation with safe initial focus and explicit global scope", () => {
    expect(source).toContain("{#if confirmingClear}");
    expect(source).toContain("<DeleteConfirmationDialog");
    expect(source).toContain("all projects and sources, not just the filtered records");
    expect(source).toContain("Logging stays enabled");
    expect(source).not.toContain("window.confirm");
    // This command must never accept the current filters or a caller-provided path.
    expect(source).toContain('>("clear_diagnostic_logs")');
    expect(source).toContain("if (clearing || !mounted) return;");
    expect(source).toContain("if (!mounted) return;");
    expect(source).toContain("mounted = false;");
  });
});
