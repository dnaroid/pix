import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import PlanProgressIndicator from "./PlanProgressIndicator.svelte";

describe("plan checklist indicator", () => {
  it("renders a Steps-style ring in the plan colour with accessible counts and no icon", () => {
    const html = render(PlanProgressIndicator, { props: { progress: { completed: 13, total: 17 } } }).body;
    expect(html).toContain("13/17");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemax="17"');
    expect(html).toContain('aria-valuenow="13"');
    expect(html).toContain('aria-valuetext="13 of 17 checklist items completed"');
    expect(html).toContain("data-plan-checklist-progress");
    expect(html).toContain("<circle");
    expect(html).toContain("text-tool-skill");
    expect(html).not.toContain("text-tool-info");
    expect(html).not.toContain("lucide-file-check");
    expect(html).not.toContain("animate-spin");
  });

  it("distinguishes zero, complete, empty and unavailable progress", () => {
    const empty = render(PlanProgressIndicator, { props: { progress: { completed: 0, total: 0 } } }).body;
    expect(empty).toContain("No checklist items");
    expect(empty).not.toContain('role="progressbar"');
    const unavailable = render(PlanProgressIndicator, { props: { progress: null } }).body;
    expect(unavailable).toContain("Checklist progress unavailable");
    expect(unavailable).not.toContain("0/0");
    for (const completed of [0, 3]) {
      const html = render(PlanProgressIndicator, { props: { progress: { completed, total: 3 } } }).body;
      expect(html).toContain(`${completed}/3`);
      expect(html).toContain(`stroke-dashoffset="${completed === 3 ? 0 : 100}"`);
    }
  });
});
