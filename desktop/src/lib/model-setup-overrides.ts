import type { ModelSetupSlot } from "./acp-pix-extensions";

/** Desktop profile and optional settings support an explicit thinking reset. */
export function modelSetupOverrides(
  slots: readonly ModelSetupSlot[],
  picks: Readonly<Record<string, string>>,
  lists: Readonly<Record<string, readonly string[]>>,
  thinking: Readonly<Record<string, string>>,
): Record<string, string | readonly string[]> {
  return { ...picks, ...lists, ...Object.fromEntries(Object.entries(thinking)
    .filter(([id, value]) => value || slots.some(slot => slot.id === id && slot.thinking && (slot.optional || slot.file === "desktop")))
    .map(([id, value]) => [`${id}:thinking`, value])) };
}
