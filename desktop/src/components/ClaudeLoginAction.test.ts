import { describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import ClaudeLoginAction from "./ClaudeLoginAction.svelte";
import transcriptSource from "./TranscriptPane.svelte?raw";

describe("Claude login action presentation", () => {
  it("renders a keyboard-accessible explicit sign-in action without starting login", () => {
    const onOpenTerminal = vi.fn();
    const html = render(ClaudeLoginAction, { props: { onOpenTerminal, onError: vi.fn() } }).body;
    expect(html).toContain('type="button"');
    expect(html).toContain("Sign in to Claude");
    expect(html).toContain("then return here and retry your request");
    expect(onOpenTerminal).not.toHaveBeenCalled();
  });

  it("offers Continue only when a resume handler is provided", () => {
    const base = { onOpenTerminal: vi.fn(), onError: vi.fn() };
    expect(render(ClaudeLoginAction, { props: base }).body).not.toContain("data-claude-login-continue");
    const onContinue = vi.fn(async () => "sent");
    const html = render(ClaudeLoginAction, { props: { ...base, onContinue } }).body;
    expect(html).toContain("data-claude-login-continue");
    expect(html).toContain("then press Continue to resume");
    expect(onContinue).not.toHaveBeenCalled();
    expect(transcriptSource).toContain("item.id === claudeLoginContinueItemId ? () => onChoiceActionsSubmit(\"Continue\")");
  });

  it("gates recovery to recognized error notices and tears down on session changes", () => {
    expect(transcriptSource).toContain("isClaudeLoginError(item.messageId, item.text)");
    expect(transcriptSource).toContain("{#key activeSessionId}\n                      <ClaudeLoginAction");
  });
});
