import { describe, expect, it } from "vitest";
import { claudeAccountSwitcherConfig, selectClaudeAccountInSource } from "./claude-account-switcher";
import { parseSettingsSource } from "./settings";

const config = `{
  // Keep account settings and unrelated keys untouched.
  "enabled": true,
  "claudeCodeProvider": {
    "autoRotate": true,
    "rotationDelaySeconds": 60,
    "accounts": [
      { "name": "Personal", "configDir": "~/.claude-personal" },
      { "name": "Work", "configDir": "~/.claude-work" }
    ]
  }
}`;

describe("Claude subscription account selector", () => {
  it("returns configured account choices without exposing any credential content", () => {
    const selection = claudeAccountSwitcherConfig(config);
    expect(selection.accounts.map(({ name }) => name)).toEqual(["Personal", "Work"]);
    expect(selection.autoRotate).toBe(true);
    expect(selection.selectedAccount).toBe("");
  });

  it("updates only preferred account and preserves the remaining JSONC", () => {
    const switched = selectClaudeAccountInSource(config, "Work");
    const parsed = parseSettingsSource(switched).value;
    expect(switched).toContain("// Keep account settings and unrelated keys untouched.");
    expect(parsed.enabled).toBe(true);
    expect(parsed.claudeCodeProvider).toMatchObject({
      autoRotate: true,
      rotationDelaySeconds: 60,
      selectedAccount: "Work",
      accounts: [
        { name: "Personal", configDir: "~/.claude-personal" },
        { name: "Work", configDir: "~/.claude-work" },
      ],
    });
    expect(claudeAccountSwitcherConfig(switched).selectedAccount).toBe("Work");
    const auto = selectClaudeAccountInSource(switched, "");
    expect(claudeAccountSwitcherConfig(auto).selectedAccount).toBe("");
    expect(auto).not.toContain('"selectedAccount"');
  });

  it("rejects missing accounts and broken source rather than overwriting it", () => {
    expect(() => selectClaudeAccountInSource(config, "Other")).toThrow(/not configured/);
    expect(() => claudeAccountSwitcherConfig('{ invalid')).toThrow(/invalid JSONC/);
    expect(claudeAccountSwitcherConfig('{"claudeCodeProvider":{"autoRotate":false}}').accounts).toEqual([]);
    expect(claudeAccountSwitcherConfig('{"claudeCodeProvider":{"accounts":[]}}').accounts).toEqual([]);
    expect(claudeAccountSwitcherConfig('{"claudeCodeProvider":{"accounts":[{"name":"","configDir":""}]}}').accounts).toEqual([]);
  });
});
