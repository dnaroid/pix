import type { ChoiceActions } from "./choice-actions";

interface ChoiceActionsState {
  selected: number[];
  submitting: boolean;
  submitted: boolean;
  error: string;
}

/** Window-local state, independent of transcript component mount/unmount. */
export function createChoiceActionsStateCache(limit = 512) {
  const entries = new Map<string, ChoiceActionsState>();

  return {
    get(scope: string | undefined, index: number, actions: ChoiceActions): ChoiceActionsState {
      const key = JSON.stringify([scope, index, actions]);
      const existing = scope ? entries.get(key) : undefined;
      if (existing) {
        entries.delete(key);
        entries.set(key, existing);
        return existing;
      }
      const state = $state<ChoiceActionsState>({
        selected: actions.items.flatMap((item, index) => item.checked ? [index] : []),
        submitting: false,
        submitted: false,
        error: "",
      });
      if (scope) {
        // Bound retained transcript state; never evict an in-flight submission.
        for (const [oldKey, oldState] of entries) {
          if (entries.size < limit) break;
          if (!oldState.submitting) entries.delete(oldKey);
        }
        entries.set(key, state);
      }
      return state;
    },
  };
}

export const choiceActionsStateCache = createChoiceActionsStateCache();
