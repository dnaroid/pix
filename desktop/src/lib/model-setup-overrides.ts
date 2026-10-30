import type { ModelSetupSlot } from "./acp-pix-extensions";

/** Empty reasoning on an optional field means reset/inherit, not an untouched choice. */
export function modelSetupOverrides(
  slots: readonly ModelSetupSlot[],
  picks: Readonly<Record<string, string>>,
  lists: Readonly<Record<string, readonly string[]>>,
  thinking: Readonly<Record<string, string>>,
): Record<string, string | readonly string[]> {
  return { ...picks, ...lists, ...Object.fromEntries(Object.entries(thinking)
    .filter(([id, value]) => value || slots.some(slot => slot.id === id && slot.thinking && slot.optional))
    .map(([id, value]) => [`${id}:thinking`, value])) };
}
