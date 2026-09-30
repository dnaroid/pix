import { registryPrimaryAction, type RegistryItem, type RegistryItemAction } from "./registry";

/** One routine command plus optional Compare stay visible; everything else is overflow. */
export function registryCardActions(item: RegistryItem): {
  primary: RegistryItemAction | undefined;
  secondary: RegistryItemAction[];
} {
  const primary = registryPrimaryAction(item);
  return { primary, secondary: item.actions.filter((action) => action !== primary) };
}

export function registryMenuPosition(anchor: { right: number; top: number; bottom: number },
  width: number, height: number, viewportWidth: number, viewportHeight: number): { left: number; top: number } {
  const margin = 8;
  const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, max - margin));
  return {
    left: clamp(anchor.right - width, viewportWidth - width),
    top: clamp(anchor.bottom + 4 + height <= viewportHeight - margin
      ? anchor.bottom + 4 : anchor.top - height - 4, viewportHeight - height),
  };
}
