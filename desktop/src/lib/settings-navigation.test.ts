import { describe, expect, it } from "vitest";
import { currentSettingsSection, SETTINGS_GROUPS, settingsSearchMatches } from "./settings-navigation";

describe("continuous settings navigation", () => {
  it("matches labels and descriptions case-insensitively with whitespace-separated terms", () => {
    expect(settingsSearchMatches("  NOTIFICATIONS native ", "General System notifications Send native notifications")).toBe(true);
    expect(settingsSearchMatches("notifications voice", "General System notifications Send native notifications")).toBe(false);
    expect(settingsSearchMatches("  ", "anything")).toBe(true);
    expect(settingsSearchMatches("DCP", "DCP Summarizer model")).toBe(true);
  });

  it("tracks the last chapter past the sticky header, including last chapter at scroll end", () => {
    const sections = [{ id: "general", top: -200 }, { id: "models", top: 90 }, { id: "voice", top: 450 }];
    expect(currentSettingsSection(sections, 100, false)).toBe("models");
    expect(currentSettingsSection(sections, 80, false)).toBe("general");
    expect(currentSettingsSection(sections, 100, true)).toBe("voice");
    expect(currentSettingsSection([], 100, true)).toBe("");
  });

  it("includes both files with unique stable chapter identities", () => {
    const ids = Object.entries(SETTINGS_GROUPS).flatMap(([kind, group]) => group.sections.map((section) => `${kind}-${section.id}`));
    expect(ids).toHaveLength(14);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("pi-tools-suite-subagents");
    expect(ids).toContain("desktop-source-control");
  });
});
