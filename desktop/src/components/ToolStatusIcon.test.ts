import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import ToolStatusIcon from "./ToolStatusIcon.svelte";

describe("activity identity and status color", () => {
  const states = [
    { status: "pending", color: "text-muted-foreground" },
    { status: "in_progress", color: "text-primary" },
    { status: "completed", color: "text-tool-success" },
    { status: "failed", color: "text-tool-error" },
    { status: "completed", attention: "warning", color: "text-tool-warning" },
    { status: "completed", attention: "error", color: "text-tool-error" },
    { status: "failed", attention: "warning", color: "text-tool-error" },
  ] as const;

  for (const [label, icon, imageRead] of [
    ["shell", "terminal", false], ["functions.apply_patch", "file-pen", false],
    ["thinking", "brain", false], ["read", "image", true],
    ["skill simplify", "graduation-cap", false], ["custom_tool", "wrench", false],
  ] as const) {
    it.each(states)(`${label} keeps its icon for $status / $attention`, ({ color, ...state }) => {
      const html = render(ToolStatusIcon, { props: { label, imageRead, ...state } }).body;
      expect(html).toContain(`lucide-${icon}`);
      expect(html).toContain(color);
      expect(html).toContain(`aria-label="${label}: ${state.status === "completed" && "attention" in state ? state.attention : state.status}"`);
      for (const statusIcon of ["circle-check", "circle-x", "loader-circle", "triangle-alert"])
        expect(html).not.toContain(`lucide-${statusIcon}`);
      expect(html).not.toContain("animate-spin");
    });
  }
});
