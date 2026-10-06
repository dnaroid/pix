import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import { createRawSnippet } from "svelte";
import BtwPane from "./BtwPane.svelte";
import type { BtwPaneState } from "../app/btw.svelte";
import BtwModelControl from "./BtwModelControl.svelte";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { createModelPreferencesStore } from "../app/model-preferences.svelte";

const state: BtwPaneState = {
  sessionId: "parent", runtimeId: "runtime", contextKey: "context", hidden: false,
  draft: "", modelRef: null, actualModelRef: "fixture/old", history: [], excerpts: [],
  thinkingLevel: null, thinkingByModel: {}, actualThinkingLevel: "low",
  busyRequestId: null, preparing: false, pendingQuestion: null, answer: "", phase: "idle",
  error: null, context: { key: "context", capturedAt: 0, records: 98, inputChars: 4000, truncated: false, historyReset: false },
  historyClipped: false, historyReset: false, usage: { inputTokens: 43497, outputTokens: 202 }, scrollTop: 0,
};
const configOptions: SessionConfigOption[] = [
  { id: "model", name: "Model", type: "select", currentValue: "fixture/main", options: [
    { value: "fixture/main", name: "Main model", _meta: { "pix.thinkingLevels": ["off", "minimal", "high"] } },
    { value: "fixture/fast", name: "Fast model", _meta: { "pix.thinkingLevels": ["off", "minimal", "high"] } },
  ] },
  { id: "thought_level", name: "Thinking", type: "select", currentValue: "minimal", options: [{ value: "minimal", name: "minimal" }] },
];
const noop = () => {};
function markup(overrides: Partial<BtwPaneState> = {}): string {
  return render(BtwPane, { props: {
    state: { ...state, ...overrides },
    modelControl: createRawSnippet(() => ({ render: () => "<span>Model control</span>" })),
    onWidthChange: noop, onScroll: noop, onDraftChange: noop,
    onSend: noop, onStop: noop, onClose: noop, onNewConversation: noop,
    onAddSelectedText: noop, onRemoveExcerpt: noop, onInsertAnswer: () => false,
  } }).body;
}
function controlMarkup(overrides: Partial<BtwPaneState> = {}): string {
  return render(BtwModelControl, { props: {
    chat: { ...state, ...overrides }, configOptions, ready: true,
    preferences: {} as ReturnType<typeof createModelPreferencesStore>,
    onSelect: noop, onFocusInput: noop,
  } }).body;
}

describe("BTW pane chrome", () => {
  it("renders the model selector once in the header, not the footer or stale metadata", () => {
    const html = markup();
    expect(html.slice(html.indexOf("<header"), html.indexOf("</header>"))).toContain("Model control");
    expect(html.slice(html.indexOf("<footer"))).not.toContain("Model control");
    expect(html).toContain("lucide-x");
    expect(html).not.toContain("lucide-panel-right-close");
    for (const text of ["Temporary ·", "Context at", "98 records", "Last response:", "fixture/old", "Shortened to fit"]) {
      expect(html).not.toContain(text);
    }
  });

  it("uses the current selected model's display name without the provider", () => {
    const inherited = controlMarkup();
    expect(inherited).toContain("Main model");
    expect(inherited).toContain("minimal");
    expect(inherited).not.toContain("fixture/");
    const selected = controlMarkup({ modelRef: "fixture/fast", thinkingLevel: "high" });
    expect(selected).toContain("Fast model");
    expect(selected).toContain("high");
    expect(selected).not.toContain("Main model");
    expect(selected).not.toContain("fixture/");
    expect(selected).toContain('aria-label="Use main model and effort for BTW"');
    expect(controlMarkup({ modelRef: "fixture/custom" })).toContain("custom");
  });

  it("keeps a concise context-shortening notice only when relevant", () => {
    expect(markup()).not.toContain("Context shortened to fit.");
    expect(markup({ context: { ...state.context!, truncated: true } })).toContain("Context shortened to fit.");
  });
});
