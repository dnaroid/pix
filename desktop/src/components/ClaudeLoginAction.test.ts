import { describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import ClaudeLoginAction from "./ClaudeLoginAction.svelte";
import TranscriptPane from "./TranscriptPane.svelte";
import type { MessageItem } from "../lib/transcript";
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

  const authError: MessageItem = {
    type: "message", id: "auth-error", messageId: "pix-system:error:1", role: "system",
    text: "Claude Code request failed (401): Failed to authenticate: OAuth token revoked.", attachments: [],
  };
  function transcriptHtml(items: MessageItem[], promptRunning = false): string {
    return render(TranscriptPane, { props: {
      transcript: { items }, activeSessionId: "session", workspace: "/project",
      promptRunning, operationRunning: false, historyLoading: false, showScrollToBottom: false,
      onScroll: vi.fn(), onScrollToBottom: vi.fn(), onLoadOlderHistory: async () => false,
      onChooseWorkspace: vi.fn(), onOpenAttachment: vi.fn(), onPrepareAttachment: async () => {},
      onValidateProjectFile: async () => true, onValidateLocalFile: async () => true,
      onOpenProjectFile: vi.fn(), onResolveProjectMedia: async () => undefined,
      onOpenLocalFile: vi.fn(), onResolveLocalMedia: async () => undefined,
      onLoadToolResult: vi.fn(), onUserMessageAction: vi.fn(),
      onOpenClaudeLoginTerminal: async () => {}, onClaudeLoginError: vi.fn(),
      onChoiceActionsSubmit: async () => "sent" as const,
    } }).body;
  }

  it("hides stale login controls after retry and successful continuation, preserving the error", () => {
    expect(transcriptHtml([authError])).toContain("data-claude-login-action");
    const continuation: MessageItem = {
      type: "message", id: "continue", role: "user", text: "Continue", attachments: [],
    };
    const answer: MessageItem = { ...continuation, id: "answer", role: "assistant", text: "Recovered" };
    for (const html of [
      transcriptHtml([authError], true),
      transcriptHtml([authError, continuation], true),
      transcriptHtml([authError, continuation, answer]),
    ]) {
      expect(html).toContain(authError.text);
      expect(html).not.toContain("data-claude-login-action");
      expect(html).not.toContain("Complete sign-in");
    }
  });

  it("offers recovery again only on the latest failed attempt", () => {
    const latest = { ...authError, id: "auth-error-2", messageId: "pix-system:error:2" };
    const html = transcriptHtml([authError, latest]);
    expect(html.match(/data-claude-login-action/g)).toHaveLength(1);
    expect(html.match(/data-claude-login-continue/g)).toHaveLength(1);
  });
});
