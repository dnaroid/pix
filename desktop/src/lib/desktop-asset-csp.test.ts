import { describe, expect, it } from "vitest";
import config from "../../src-tauri/tauri.conf.json";
import releaseConfig from "../../src-tauri/tauri.release.conf.json";

describe("Desktop asset CSP", () => {
  it("leaves runtime xterm styles inline without exempting scripts or other directives", () => {
    const { csp, dangerousDisableAssetCspModification } = config.app.security;

    expect(dangerousDisableAssetCspModification).toEqual(["style-src"]);
    expect(csp.split(";").map((directive: string) => directive.trim()))
      .toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toMatch(/(?:^|;)\s*script-src\s+[^;]*'unsafe-inline'/);
    // Release config merges on top of the base config; it must not undo the scoped exemption.
    expect("app" in releaseConfig).toBe(false);
  });
});
