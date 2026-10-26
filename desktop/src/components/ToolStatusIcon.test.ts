import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import ToolStatusIcon from "./ToolStatusIcon.svelte";

describe("image read status icon", () => {
  it("replaces only the completed checkmark, keeping lifecycle and attention states", () => {
    const html = render(ToolStatusIcon, { props: { status: "completed", imageRead: true } }).body;
    expect(html).toContain("lucide-image");
    expect(html).toContain("text-tool-success");
    expect(html).not.toContain("lucide-circle-check");
    for (const props of [
      { status: "failed" as const }, { status: "in_progress" as const }, { status: "pending" as const },
      { status: "completed" as const, attention: "warning" as const },
    ]) expect(render(ToolStatusIcon, { props: { ...props, imageRead: true } }).body).not.toContain("lucide-image");
    expect(render(ToolStatusIcon, { props: { status: "completed" } }).body).toContain("lucide-circle-check");
  });
});
