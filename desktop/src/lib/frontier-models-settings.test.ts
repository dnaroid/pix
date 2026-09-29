import { describe, expect, it } from "vitest";
import { DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC } from "../../../external/pi-tools-suite/src/default-pi-tools-suite-config.js";
import {
  addFrontierModelRow,
  frontierModelRowDetails,
  frontierModelRows,
  frontierOraclePreview,
  moveFrontierModelRow,
  removeFrontierModelRow,
  serializeFrontierModelRows,
  updateFrontierModelRow,
} from "./frontier-models-settings.js";
import { parseSettingsSource, settingsValue, updateSettingsSource } from "./settings.js";

const defaults = frontierModelRows(settingsValue(parseSettingsSource(DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC).value, ["frontierModels"]));

describe("frontier model settings rows", () => {
  it("reads the shipped default list with flags and preserved Advanced-only fields", () => {
    expect(defaults.map(({ model, expensive, enabled }) => ({ model, expensive, enabled }))).toEqual([
      { model: "openai-codex/gpt-6-astra", expensive: true, enabled: true },
      { model: "openai-codex/gpt-6.1-sol", expensive: true, enabled: true },
      { model: "zai/glm-5.3", expensive: false, enabled: true },
    ]);
    expect(defaults[0]!.extra).toEqual({ aliases: ["*gpt*astra*"], roles: ["oracle"] });
  });

  it("round-trips entries without losing vendor, aliases, roles, or unknown keys", () => {
    const raw = [
      "zai/glm-5.3",
      { model: "custom/house", vendor: "acme", aliases: ["*house*"], roles: ["oracle"], future: 1, enabled: false },
      { model: "openai-codex/gpt-7", expensive: true },
      { model: "" },
      42,
    ];
    const rows = frontierModelRows(raw);
    expect(rows.map((row) => row.model)).toEqual(["zai/glm-5.3", "custom/house", "openai-codex/gpt-7"]);
    expect(serializeFrontierModelRows(rows)).toEqual([
      { model: "zai/glm-5.3" },
      { model: "custom/house", vendor: "acme", aliases: ["*house*"], roles: ["oracle"], future: 1, enabled: false },
      { model: "openai-codex/gpt-7", expensive: true },
    ]);
    expect(frontierModelRows("zai/glm-5.3")).toEqual([]);
  });

  it("toggles flags, reorders within bounds, adds without duplicates, and removes", () => {
    let rows = updateFrontierModelRow(defaults, 2, { expensive: true, enabled: false });
    expect(serializeFrontierModelRows(rows)[2]).toEqual({ model: "zai/glm-5.3", expensive: true, enabled: false });
    rows = updateFrontierModelRow(rows, 2, { expensive: false, enabled: true });
    expect(serializeFrontierModelRows(rows)[2]).toEqual({ model: "zai/glm-5.3" });

    expect(moveFrontierModelRow(defaults, 2, -1).map((row) => row.model)).toEqual(["openai-codex/gpt-6-astra", "zai/glm-5.3", "openai-codex/gpt-6.1-sol"]);
    expect(moveFrontierModelRow(defaults, 0, -1).map((row) => row.model)).toEqual(defaults.map((row) => row.model));
    expect(moveFrontierModelRow(defaults, 2, 1).map((row) => row.model)).toEqual(defaults.map((row) => row.model));

    expect(addFrontierModelRow(defaults, "zai/glm-5.3")).toHaveLength(3);
    expect(addFrontierModelRow(defaults, " anthropic/claude-opus-5 ").at(-1)).toEqual({ model: "anthropic/claude-opus-5", expensive: false, enabled: true, extra: {} });
    expect(removeFrontierModelRow(defaults, 0).map((row) => row.model)).toEqual(["openai-codex/gpt-6.1-sol", "zai/glm-5.3"]);
  });

  it("drops the replaced model's vendor and aliases but keeps role limits", () => {
    const rows = frontierModelRows([
      { model: "openai-codex/gpt-6.1-sol", expensive: true, vendor: "openai", aliases: ["*gpt-6.1-sol*"], roles: ["oracle"], future: 1 },
    ]);
    const replaced = updateFrontierModelRow(rows, 0, { model: "anthropic/claude-opus-5-5" });
    expect(serializeFrontierModelRows(replaced)).toEqual([
      { model: "anthropic/claude-opus-5-5", roles: ["oracle"], future: 1, expensive: true },
    ]);
    expect(frontierModelRowDetails(replaced[0]!)).toBe("anthropic · only oracle");
    expect(updateFrontierModelRow(rows, 0, { model: "openai-codex/gpt-6.1-sol", enabled: false })[0]!.extra).toEqual(rows[0]!.extra);
    // With the Sol alias gone, Opus is an ordinary anthropic oracle candidate.
    expect(frontierOraclePreview([...replaced, ...frontierModelRows(["zai/glm-5.3"])], false)).toEqual([
      { parent: "claude-opus-5-5", vendor: "anthropic", candidates: ["glm-5.3"] },
      { parent: "glm-5.3", vendor: "zai", candidates: ["claude-opus-5-5"] },
    ]);
  });

  it("writes the list back into JSONC while keeping other settings", () => {
    const source = '{\n  // keep me\n  "economy": true\n}\n';
    const next = updateSettingsSource(source, ["frontierModels"], serializeFrontierModelRows(removeFrontierModelRow(defaults, 1)));
    expect(next).toContain("// keep me");
    const parsed = parseSettingsSource(next).value;
    expect(parsed.economy).toBe(true);
    expect(frontierModelRows(parsed.frontierModels).map((row) => row.model)).toEqual(["openai-codex/gpt-6-astra", "zai/glm-5.3"]);
  });

  it("summarizes Advanced-only fields", () => {
    expect(frontierModelRowDetails(defaults[0]!)).toBe("openai · only oracle · aliases *gpt*astra*");
    expect(frontierModelRowDetails(defaults[2]!)).toBe("zai");
    expect(frontierModelRowDetails(frontierModelRows([{ model: "custom/house", vendor: "acme" }])[0]!)).toBe("acme");
  });
});

describe("frontier oracle preview", () => {
  it("shows the runtime oracle chain for one frontier parent per vendor", () => {
    expect(frontierOraclePreview(defaults, false)).toEqual([
      { parent: "gpt-6-astra", vendor: "openai", candidates: ["glm-5.3"] },
      { parent: "glm-5.3", vendor: "zai", candidates: ["gpt-6-astra", "gpt-6.1-sol"] },
    ]);
  });

  it("reflects economy, disabled entries, and an empty chain", () => {
    expect(frontierOraclePreview(defaults, true)).toEqual([
      { parent: "gpt-6-astra", vendor: "openai", candidates: ["glm-5.3"] },
      { parent: "glm-5.3", vendor: "zai", candidates: [] },
    ]);
    const withoutSol = updateFrontierModelRow(defaults, 1, { enabled: false });
    expect(frontierOraclePreview(withoutSol, false)[1]).toEqual({ parent: "glm-5.3", vendor: "zai", candidates: ["gpt-6-astra"] });
    expect(frontierOraclePreview([], false)).toEqual([]);
  });
});
