import { describe, expect, it } from "vitest";
import configSource from "../../src-tauri/tauri.conf.json?raw";

describe("native window interaction defaults", () => {
  it("lets the activating click reach controls in inactive macOS windows", () => {
    const config = JSON.parse(configSource);
    // Native startup and new project windows clone this shared configuration.
    expect(config.app.windows.length).toBeGreaterThan(0);
    for (const window of config.app.windows) {
      expect(window.acceptFirstMouse).toBe(true);
    }
  });
});
