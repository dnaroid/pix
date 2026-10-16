import { describe, expect, it } from "vitest";
import { vividLogoColor } from "./project-logo-color";

function pixels(...runs: Array<[count: number, rgba: [number, number, number, number]]>): number[] {
  return runs.flatMap(([count, rgba]) => Array.from({ length: count }, () => rgba).flat());
}

describe("vividLogoColor", () => {
  it("prefers a vivid symbol over a larger dark background", () => {
    const color = vividLogoColor(pixels([800, [20, 22, 28, 255]], [200, [230, 60, 200, 255]]));
    expect(color).toBe("#e63cc8");
  });

  it("ignores transparent, white and gray pixels", () => {
    expect(vividLogoColor(pixels(
      [500, [255, 0, 0, 0]], [300, [250, 250, 250, 255]], [300, [128, 128, 128, 255]], [50, [30, 120, 240, 255]],
    ))).toBe("#1e78f0");
  });

  it("weights saturation so a vivid accent beats a larger muted hue", () => {
    expect(vividLogoColor(pixels([400, [140, 110, 90, 255]], [200, [20, 200, 90, 255]]))).toBe("#14c85a");
  });

  it("falls back to the most frequent color for monochrome logos", () => {
    expect(vividLogoColor(pixels([10, [255, 255, 255, 255]], [90, [16, 16, 16, 255]]))).toBe("#101010");
    expect(vividLogoColor([])).toBeUndefined();
  });
});
