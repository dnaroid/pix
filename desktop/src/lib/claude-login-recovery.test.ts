import { describe, expect, it } from "vitest";
import { claudeLoginCommand, claudeLoginProfiles, isClaudeLoginError } from "./claude-login-recovery";

describe("Claude sign-in recovery", () => {
  const expired = "Claude Code request failed: Failed to authenticate: OAuth session expired and could not be refreshed";
  it("recognizes expired and missing Claude login only on host error rows", () => {
    expect(isClaudeLoginError("pix-system:error:1", expired)).toBe(true);
    expect(isClaudeLoginError("pix-system:notification:error:1", "[pi-claude-code-provider] Claude Code is not logged in. Run `claude auth login`" )).toBe(true);
    expect(isClaudeLoginError("pix-system:error:1", "Claude Code request failed (401): Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.")).toBe(true);
    for (const id of [undefined, "assistant:1", "pix-system:notification:warning:1", "pix-system:1"]) {
      expect(isClaudeLoginError(id, expired)).toBe(false);
    }
    for (const text of ["Failed to authenticate", "Claude Code request failed: rate limited", "OpenAI OAuth session expired"]) {
      expect(isClaudeLoginError("pix-system:error:1", text)).toBe(false);
    }
  });

  it("uses the configured preference or rotation starting profile without changing settings", () => {
    const config = { autoRotate: true, accounts: [{ name: "One", configDir: "~/.one" }, { name: "Two", configDir: "~/.two" }] };
    const profiles = (value: object) => claudeLoginProfiles(JSON.stringify({ claudeCodeProvider: value }));
    expect(profiles(config).selected).toBe("One");
    expect(profiles({ ...config, selectedAccount: "Two" }).selected).toBe("Two");
    expect(profiles({ ...config, autoRotate: false }).selected).toBe("");
    expect(claudeLoginProfiles("{}").accounts).toEqual([]);
    expect(() => claudeLoginProfiles("{broken")).toThrow();
  });

  it("pins named config paths and safely honors the CLI executable override", () => {
    const command = '"${PI_CLAUDE_CODE_PROVIDER_PATH:-claude}" auth login --claudeai';
    expect(claudeLoginCommand()).toBe(command);
    expect(claudeLoginCommand("~/.claude-work")).toBe(`CLAUDE_CONFIG_DIR="$HOME/.claude-work" ${command}`);
    expect(claudeLoginCommand("/a'b $(touch x)")).toBe(`CLAUDE_CONFIG_DIR='/a'\\''b $(touch x)' ${command}`);
    expect(claudeLoginCommand('~/.a"$`\\')).toContain('"$HOME/.a\\"\\$\\`\\\\"');
    for (const path of ["/a\nb", "/a\rb", "/a\0b"]) expect(() => claudeLoginCommand(path)).toThrow(/control characters/);
  });
});
