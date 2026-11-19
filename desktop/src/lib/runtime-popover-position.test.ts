import { describe, expect, it } from "vitest";
import { runtimePopoverLeft } from "./runtime-popover-position";

describe("runtime popover horizontal placement", () => {
  const bounds = { left: 53, right: 912 };
  const anchor = { left: 337, right: 385 };

  it("shifts Usage right when its preferred placement is clipped by the workbench", () => {
    expect(anchor.left + runtimePopoverLeft(anchor, bounds, 360, "right")).toBe(bounds.left);
  });

  it("keeps Usage right-aligned when there is room", () => {
    const wideAnchor = { left: 512, right: 560 };
    expect(wideAnchor.left + runtimePopoverLeft(wideAnchor, bounds, 360, "right") + 360).toBe(wideAnchor.right);
  });

  it("keeps Context left-aligned unless it would cross the right edge", () => {
    expect(runtimePopoverLeft(anchor, bounds, 288, "left")).toBe(0);
    const narrowBounds = { left: 53, right: 410 };
    expect(anchor.left + runtimePopoverLeft(anchor, narrowBounds, 288, "left") + 288).toBe(narrowBounds.right);
  });
});
