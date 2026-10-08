import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import type { MenuNavigationItem } from "./keyboard-navigation";
import type { ContextMenuPosition, NativeContextMenu } from "./native-context-menu";
import type { ProjectTreeEntry } from "./project-tree";

export interface ProjectExplorerMenuAction extends MenuNavigationItem {
  id: string;
  action: () => void | Promise<void>;
  separatorBefore?: boolean;
}

export function canOpenProjectEntryInBrowser(entry: ProjectTreeEntry): boolean {
  return entry.kind === "file" && /\.html?$/i.test(entry.path);
}

/** Adapt the shared command policy without duplicating enablement or ordering. */
export function projectExplorerMenuActions(
  items: readonly MenuNavigationItem[],
  commands: Readonly<Record<string, () => void | Promise<void>>>,
  revealLabel: string,
  root: boolean,
): ProjectExplorerMenuAction[] {
  return items.map((item) => {
    const action = commands[item.label];
    if (!action) throw new Error(`Unknown Project Explorer command: ${item.label}`);
    let id = item.label;
    if (item.label === revealLabel) id = "reveal";
    else if (item.label === "Open in Browser") id = "browser";
    else if (item.label.startsWith("Open ")) id = "external";
    return {
      ...item, id, action,
      separatorBefore: item.label === "New File…" || item.label === "Copy"
        || (root && item.label === "Paste") || item.label === "Delete",
    };
  });
}

interface Options {
  prepare: (entry: ProjectTreeEntry) => Promise<void>;
  items: (entry: ProjectTreeEntry) => readonly ProjectExplorerMenuAction[];
  reportError: (error: unknown) => void;
  createMenu?: (items: readonly ProjectExplorerMenuAction[], isActive: () => boolean) => Promise<NativeContextMenu>;
}

export function createProjectExplorerNativeMenu(options: Options) {
  const namespace = `project-explorer:${crypto.randomUUID()}`;
  let pending: Promise<unknown> = Promise.resolve();
  let generation = 0;
  let disposed = false;
  let active: { menu: NativeContextMenu; valid: boolean } | null = null;
  const released = new WeakSet<NativeContextMenu>();
  const create = options.createMenu ?? (async (actions, isActive) => {
    const items = actions.flatMap((item) => [
      ...(item.separatorBefore ? [{ item: "Separator" as const }] : []),
      {
        id: `${namespace}:${item.id}`, text: item.label, enabled: !item.disabled,
        action: () => {
          void Promise.resolve().then(() => {
            if (isActive() && !item.disabled) return item.action();
          }).catch(options.reportError);
        },
      },
    ]);
    const menu = await Menu.new({ items });
    return {
      popup: ({ x, y }: ContextMenuPosition) => menu.popup(new LogicalPosition(x, y)),
      close: () => menu.close(),
    };
  });

  async function release(menu: NativeContextMenu): Promise<void> {
    if (released.has(menu)) return;
    released.add(menu);
    try { await menu.close(); }
    catch (error) { if (!disposed) options.reportError(error); }
  }

  function close(): void {
    generation++;
    if (active) {
      active.valid = false;
      void release(active.menu);
      active = null;
    }
  }

  async function show(entry: ProjectTreeEntry, position: ContextMenuPosition, isTargetCurrent: () => boolean): Promise<void> {
    close();
    const request = generation;
    const current = () => !disposed && request === generation && isTargetCurrent();
    let owned: { menu: NativeContextMenu; valid: boolean } | null = null;
    try {
      await options.prepare(entry);
      if (!current()) return;
      // Registration is app-wide: obsolete IPC must finish before newer stable ids.
      const result = pending.then(async () => {
        if (!current()) return null;
        return create(options.items(entry), () => current() && Boolean(owned?.valid));
      });
      pending = result.catch(() => undefined);
      const menu = await result;
      if (!menu) return;
      owned = { menu, valid: false };
      if (!current()) { await release(menu); return; }
      owned.valid = true;
      active = owned;
      await menu.popup(position);
      // popup resolution is not a portable dismissal notification; retain ownership.
    } catch (error) {
      if (owned) {
        owned.valid = false;
        if (active === owned) active = null;
        await release(owned.menu);
      }
      if (current()) options.reportError(error);
    }
  }

  return {
    show, close,
    hasActiveMenu: () => Boolean(active?.valid),
    dispose() { disposed = true; close(); },
  };
}
