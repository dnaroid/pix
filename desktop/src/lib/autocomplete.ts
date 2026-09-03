export interface PromptAutocompleteState {
  readonly contextKey: string;
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly hasAttachments: boolean;
  readonly enabled: boolean;
}

export type AutocompleteRequest = (draft: string, signal: AbortSignal) => Promise<string>;

interface PromptAutocompleteControllerOptions {
  readonly request: AutocompleteRequest;
  readonly onSuggestion: (suggestion: string) => void;
  readonly debounceMs?: number;
}

export class PromptAutocompleteController {
  private readonly request: AutocompleteRequest;
  private readonly onSuggestion: (suggestion: string) => void;
  private debounceMs: number;
  private key: string | undefined;
  private dismissedKey: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private requestController: AbortController | undefined;
  private suggestion = "";
  private generation = 0;
  private lastState: PromptAutocompleteState | undefined;

  constructor(options: PromptAutocompleteControllerOptions) {
    this.request = options.request;
    this.onSuggestion = options.onSuggestion;
    this.debounceMs = normalizeDebounce(options.debounceMs ?? 350);
  }

  setDebounceMs(value: number): void {
    const next = normalizeDebounce(value);
    if (next === this.debounceMs) return;
    this.debounceMs = next;
    const state = this.lastState;
    if (state && this.timer) {
      this.invalidate(false);
      this.observe(state);
    }
  }

  observe(state: PromptAutocompleteState): void {
    this.lastState = state;
    const nextKey = stateKey(state);
    if (!nextKey) {
      this.invalidate(false);
      return;
    }
    if (nextKey === this.dismissedKey || nextKey === this.key) return;

    this.dismissedKey = undefined;
    this.invalidate(false);
    this.key = nextKey;
    const generation = ++this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const controller = new AbortController();
      this.requestController = controller;
      void this.request(state.text, controller.signal)
        .then((raw) => {
          if (controller.signal.aborted || generation !== this.generation || this.key !== nextKey) return;
          this.setSuggestion(cleanAutocompleteSuffix(raw, state.text));
        })
        .catch(() => {})
        .finally(() => {
          if (this.requestController === controller) this.requestController = undefined;
        });
    }, this.debounceMs);
  }

  currentSuggestion(state: PromptAutocompleteState): string {
    return stateKey(state) === this.key ? this.suggestion : "";
  }

  accept(state: PromptAutocompleteState): string | undefined {
    const suffix = this.currentSuggestion(state);
    if (!suffix) return undefined;
    const value = state.text + suffix;
    this.invalidate(false);
    return value;
  }

  dismiss(): void {
    this.dismissedKey = this.key;
    this.invalidate(true);
  }

  dispose(): void {
    this.lastState = undefined;
    this.dismissedKey = undefined;
    this.invalidate(false);
  }

  private invalidate(preserveDismissedKey: boolean): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.requestController?.abort();
    this.requestController = undefined;
    this.key = undefined;
    if (!preserveDismissedKey) this.dismissedKey = undefined;
    this.setSuggestion("");
  }

  private setSuggestion(value: string): void {
    if (value === this.suggestion) return;
    this.suggestion = value;
    this.onSuggestion(value);
  }
}

export function isAutocompleteEligible(state: PromptAutocompleteState): boolean {
  if (!state.enabled || state.hasAttachments) return false;
  if (state.selectionStart !== state.selectionEnd || state.selectionEnd !== state.text.length) return false;
  return state.text.trim().length >= 3 && !state.text.startsWith("/") && !state.text.startsWith("!");
}

export function cleanAutocompleteSuffix(raw: string, draft: string): string {
  let value = raw.trimEnd().replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/, "");
  value = value.replace(/^(?:completion|suffix|answer)\s*:\s*/i, "");
  if (value.startsWith(draft)) value = value.slice(draft.length);
  return value.slice(0, 320);
}

function stateKey(state: PromptAutocompleteState): string | undefined {
  return isAutocompleteEligible(state) ? `${state.contextKey}\u0000${state.text}` : undefined;
}

function normalizeDebounce(value: number): number {
  return Number.isFinite(value) ? Math.min(5_000, Math.max(0, Math.round(value))) : 350;
}
