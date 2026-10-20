import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import PlanProgressRing from "./PlanProgressRing.svelte";

describe("plan card progress ring", () => {
  it("renders an accessible ring with completion counts", () => {
    const html = render(PlanProgressRing, { props: { progress: { completed: 13, total: 17 } } }).body;
    expect(html).toContain("13/17");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="13"');
    expect(html).toContain('aria-valuemax="17"');
    expect(html).toContain("<circle");
    expect(html).toContain("stroke-primary");
    expect(render(PlanProgressRing, { props: { progress: { completed: 3, total: 3 } } }).body).toContain("stroke-tool-success");
  });

  it("distinguishes empty and unavailable progress", () => {
    expect(render(PlanProgressRing, { props: { progress: { completed: 0, total: 0 } } }).body).toContain("No checklist items");
    expect(render(PlanProgressRing, { props: { progress: null } }).body).toContain("Checklist progress unavailable");
  });
});
