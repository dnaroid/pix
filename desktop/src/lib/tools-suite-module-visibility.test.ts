import { describe, expect, it } from "vitest";
import { parseSettingsSource } from "./settings.js";
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
