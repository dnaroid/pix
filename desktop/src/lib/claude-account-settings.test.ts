import { describe, expect, it } from "vitest";
import { claudeAccountRows, claudeAuthCommand } from "./claude-account-settings";
import { settingsSourceIssues, type SettingsSchema } from "./settings";

const schema: SettingsSchema = {
  type: "object",
  properties: {
    claudeCodeProvider: {
      type: "object",
      properties: {
        rotationDelaySeconds: { type: "integer", minimum: 0, maximum: 300, default: 60 },
      },
    },
  },
};

describe("Claude Code account settings", () => {
  it("keeps account rows in configured priority order", () => {
    expect(claudeAccountRows([
      { name: "Personal", configDir: "~/.claude-personal" },
      { name: "Work", configDir: "/home/example/.claude-work" },
    ])).toEqual([
      { name: "Personal", configDir: "~/.claude-personal" },
      { name: "Work", configDir: "/home/example/.claude-work" },
    ]);
  });

  it("generates safe profile-specific CLI login and status commands", () => {
    expect(claudeAuthCommand("~/.claude-personal", "login")).toBe('CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude auth login');
    expect(claudeAuthCommand("/my dir/ab'cd", "status")).toBe("CLAUDE_CONFIG_DIR='/my dir/ab'\\''cd' claude auth status");
    expect(claudeAuthCommand("~/.claude-\"$danger", "login")).toContain('\\"\\$danger');
  });

  it("blocks invalid active auto-rotation settings before a save", () => {
    const issues = (value: unknown) => settingsSourceIssues(JSON.stringify({ claudeCodeProvider: value }), schema);
    expect(issues({ autoRotate: true, accounts: [{ name: "One", configDir: "~/.claude-one" }] })[0]).toMatch(/at least two/);
    expect(issues({ autoRotate: true, accounts: [
      { name: "One", configDir: "~/.claude-one" },
      { name: "one", configDir: "~/.claude-two" },
    ] }).join(" ")).toMatch(/duplicate/);
    expect(issues({ accounts: [{ name: "Other", configDir: "relative-path" }] }).join(" ")).toMatch(/absolute/);
    expect(issues({ autoRotate: true, accounts: [
      { name: "One", configDir: "~/.claude-one" },
      { name: "Two", configDir: "/tmp/.claude-two" },
    ] })).toEqual([]);
  });

  it("validates rotation pause seconds against the Desktop settings schema", () => {
    const issues = (seconds: unknown) => settingsSourceIssues(
      JSON.stringify({ claudeCodeProvider: { rotationDelaySeconds: seconds } }),
      schema,
    );
    expect(issues(0)).toEqual([]);
    expect(issues(60)).toEqual([]);
    expect(issues(300)).toEqual([]);
    expect(issues(-1).join(" ")).toMatch(/>= 0/);
    expect(issues(301).join(" ")).toMatch(/<= 300/);
    expect(issues(1.5).join(" ")).toMatch(/integer/);
    expect(issues("60").join(" ")).toMatch(/number/);
  });
});
