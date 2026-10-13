import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import ClaudeAccountSwitcher from "./ClaudeAccountSwitcher.svelte";
import source from "./ClaudeAccountSwitcher.svelte?raw";

describe("Claude account switcher visibility", () => {
  it("renders no selector, placeholder or last-account label before configured profiles are loaded", () => {
    const html = render(ClaudeAccountSwitcher, { props: { lastAttemptedAccount: "Personal" } }).body;
    expect(html).not.toContain("data-claude-account-switcher");
    expect(html).not.toContain("Choose Claude Code OAuth account");
    expect(html).not.toContain("Last: Personal");
  });

  it("guards the entire selector on a nonempty account list, without an empty Accounts placeholder", () => {
    expect(source).toContain("{#if config.accounts.length > 0}");
    expect(source).not.toContain('<option value="">Accounts</option>');
    expect(source.indexOf("{#if config.accounts.length > 0}")).toBeLessThan(source.indexOf("data-claude-account-switcher"));
  });
});
