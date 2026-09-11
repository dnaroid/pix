import { describe, expect, it } from "vitest";
import {
  PROJECT_SWITCHER_MAX_TEXT_WIDTH,
  PROJECT_SWITCHER_MIN_TEXT_WIDTH,
  projectSwitcherMinimumWidth,
} from "./project-switcher-layout";

describe("project switcher minimum width", () => {
  it("preserves fixed controls and a useful minimum text slot", () => {
    expect(projectSwitcherMinimumWidth({
      horizontalPadding: 20,
      gap: 8,
      fixedWidths: [16, 28],
      projectNameWidth: 20,
    })).toBe(20 + 16 + 28 + 16 + PROJECT_SWITCHER_MIN_TEXT_WIDTH);
  });

  it("caps long project names so text cannot make the sidebar minimum unbounded", () => {
    expect(projectSwitcherMinimumWidth({
      horizontalPadding: 20,
      gap: 8,
      fixedWidths: [16, 28],
      projectNameWidth: 10_000,
    })).toBe(20 + 16 + 28 + 16 + PROJECT_SWITCHER_MAX_TEXT_WIDTH);
  });
});
