import { describe, expect, it } from "vitest";
import { parseSettingsSource } from "./settings.js";
import { PI_TOOLS_SUITE_MODULE_CATALOG } from "../../../external/pi-tools-suite/src/module-catalog.js";
import {
  toolsSuiteModuleStates,
  toolsSuiteUnknownModuleNames,
  updateToolsSuiteModuleSource,
} from "./tools-suite-module-visibility.js";

const catalog = [
  { name: "normal", defaultEnabled: true, description: "Normal module" },
  { name: "opt-in", defaultEnabled: false, description: "Optional module" },
] as const;

describe("tools-suite module visibility", () => {
  it("exposes default-on codemode and preserves JSONC when toggled off and on", () => {
    const source = '{\n  // keep this comment\n  "modules": { "future-module": false }\n}\n';
    const root = parseSettingsSource(source).value;
    expect(toolsSuiteModuleStates(root, PI_TOOLS_SUITE_MODULE_CATALOG).find((entry) => entry.name === "codemode")?.enabled).toBe(true);
    const off = updateToolsSuiteModuleSource(source, root, "codemode", false);
    expect(off).toContain("// keep this comment");
    expect(parseSettingsSource(off).value.modules).toEqual({ "future-module": false, codemode: false });
    expect(toolsSuiteModuleStates(parseSettingsSource(off).value, PI_TOOLS_SUITE_MODULE_CATALOG).find((entry) => entry.name === "codemode")?.enabled).toBe(false);
    const on = updateToolsSuiteModuleSource(off, parseSettingsSource(off).value, "codemode", true);
    expect(parseSettingsSource(on).value.modules).toEqual({ "future-module": false, codemode: true });
  });
  it("replays legacy/current config precedence over module defaults", () => {
    const root = parseSettingsSource(`{
      "disabledModules": ["normal"],
      "enabledExtensions": ["opt-in"],
      "modules": { "normal": true },
      "extensions": { "opt-in": false }
    }`).value;
    expect(toolsSuiteModuleStates(root, catalog).map(({ name, enabled }) => ({ name, enabled }))).toEqual([
      { name: "normal", enabled: true },
      { name: "opt-in", enabled: false },
    ]);
    expect(toolsSuiteModuleStates(root, catalog).map(({ description }) => description)).toEqual([
      "Normal module",
      "Optional module",
    ]);
  });

  it("writes one final modules override without dropping unknown configuration", () => {
    const source = `{
  "disabledModules": ["normal", "future-module"],
  "modules": { "future-map": false },
  "extensions": { "normal": false, "legacy-future": true }
}\n`;
    const root = parseSettingsSource(source).value;
    const next = updateToolsSuiteModuleSource(source, root, "normal", true);
    const parsed = parseSettingsSource(next).value;
    expect(parsed.modules).toEqual({ "future-map": false, normal: true });
    expect(parsed.extensions).toEqual({ "legacy-future": true });
    expect(parsed.disabledModules).toEqual(["normal", "future-module"]);
    expect(toolsSuiteUnknownModuleNames(parsed, catalog)).toEqual(["future-map", "future-module", "legacy-future"]);
    expect(toolsSuiteModuleStates(parsed, catalog).at(0)?.enabled).toBe(true);
  });
});
