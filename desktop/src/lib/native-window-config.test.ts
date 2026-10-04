import { describe, expect, it } from "vitest";
import configSource from "../../src-tauri/tauri.conf.json?raw";

describe("native window interaction defaults", () => {
  it("allows compact windows while preserving the full activity rail", () => {
    const config = JSON.parse(configSource);
    // Seven 40px buttons + 12px rail padding + 36px titlebar + 28px status bar.
    const requiredHeight = 7 * 40 + 12 + 36 + 28;
    for (const window of config.app.windows) {
      expect(window.minHeight).toBe(380);
      expect(window.minHeight).toBeGreaterThan(requiredHeight);
      expect(window.minWidth).toBe(860);
    }
  });

  it("lets the activating click reach controls in inactive macOS windows", () => {
    const config = JSON.parse(configSource);
    // Native startup and new project windows clone this shared configuration.
    expect(config.app.windows.length).toBeGreaterThan(0);
    for (const window of config.app.windows) {
      expect(window.acceptFirstMouse).toBe(true);
    }
  });
});
