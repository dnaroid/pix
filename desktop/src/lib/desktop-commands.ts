export type DesktopCommandScope = "application" | "workspace" | "session" | "composer" | "message";
export type DesktopShortcutPlatform = "mac" | "other";

export type DesktopCommandId =
  | "application.commandPalette"
  | "workspace.choose"
  | "session.new"
  | "session.open"
  | "session.jump"
  | "session.history"
  | "session.activity"
  | "session.modelThinking"
  | "composer.focus"
  | "composer.enhance"
  | "composer.createTask"
  | "composer.defer"
  | "message.copy"
  | "message.fork"
  | "message.forkNewTab"
  | "message.undo";

export interface DesktopShortcut {
  readonly key: string;
  readonly primary?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export interface DesktopCommandDefinition {
  readonly id: DesktopCommandId;
  readonly label: string;
  readonly description?: string;
  readonly scope: DesktopCommandScope;
  readonly shortcut?: DesktopShortcut;
  readonly keywords?: readonly string[];
  readonly destructive?: boolean;
}

interface KeyboardShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

const DEFINITIONS: Record<DesktopCommandId, DesktopCommandDefinition> = {
  "application.commandPalette": {
    id: "application.commandPalette",
    label: "Show Command Palette",
    description: "Search application commands",
    scope: "application",
    shortcut: { key: "p", primary: true, shift: true },
    keywords: ["commands", "actions", "palette"],
  },
  "workspace.choose": {
    id: "workspace.choose",
    label: "Open Project…",
    description: "Choose a project folder for this window",
    scope: "workspace",
    keywords: ["workspace", "folder", "project", "open"],
  },
  "session.new": {
    id: "session.new",
    label: "New Conversation",
    description: "Open a fresh conversation tab",
    scope: "session",
    shortcut: { key: "t", primary: true },
    keywords: ["new", "tab", "session", "conversation"],
  },
  "session.open": {
    id: "session.open",
    label: "Open Conversation…",
    description: "Search saved conversations",
    scope: "session",
    keywords: ["resume", "saved", "session", "conversation"],
  },
  "session.jump": {
    id: "session.jump",
    label: "Jump to User Message…",
    description: "Navigate to an earlier user message",
    scope: "session",
    keywords: ["navigate", "message", "jump", "history"],
  },
  "session.history": {
    id: "session.history",
    label: "Prompt History…",
    description: "Restore a previous prompt into the composer",
    scope: "session",
    keywords: ["prompt", "history", "restore", "composer"],
  },
  "session.activity": {
    id: "session.activity",
    label: "Toggle Session Activity",
    description: "Show or hide the Plan and Agents inspector",
    scope: "session",
    keywords: ["inspector", "plan", "agents", "activity"],
  },
  "session.modelThinking": {
    id: "session.modelThinking",
    label: "Select Model and Thinking…",
    description: "Choose the active model and reasoning effort",
    scope: "session",
    keywords: ["model", "thinking", "reasoning", "effort"],
  },
  "composer.focus": {
    id: "composer.focus",
    label: "Focus Composer",
    description: "Move keyboard focus to the prompt editor",
    scope: "composer",
    keywords: ["prompt", "input", "editor", "focus"],
  },
  "composer.enhance": {
    id: "composer.enhance",
    label: "Enhance prompt",
    description: "Rewrite the current prompt with Pix",
    scope: "composer",
    keywords: ["prompt", "rewrite", "improve"],
  },
  "composer.createTask": {
    id: "composer.createTask",
    label: "Create task",
    description: "Create a project task from the current draft",
    scope: "composer",
    keywords: ["task", "todo", "project"],
  },
  "composer.defer": {
    id: "composer.defer",
    label: "Pause for later",
    description: "Move the current draft to the queued-message panel",
    scope: "composer",
    keywords: ["queue", "defer", "pause", "later"],
  },
  "message.copy": {
    id: "message.copy",
    label: "Copy message",
    scope: "message",
    keywords: ["copy", "clipboard"],
  },
  "message.fork": {
    id: "message.fork",
    label: "Fork",
    description: "Fork the conversation from this message",
    scope: "message",
    keywords: ["branch", "conversation"],
  },
  "message.forkNewTab": {
    id: "message.forkNewTab",
    label: "Fork in new tab",
    description: "Fork this message into a new conversation tab",
    scope: "message",
    keywords: ["branch", "conversation", "tab"],
  },
  "message.undo": {
    id: "message.undo",
    label: "Undo changes",
    description: "Undo workspace mutations associated with this message",
    scope: "message",
    keywords: ["undo", "revert", "changes"],
    destructive: true,
  },
};

export const COMMAND_PALETTE_IDS: readonly DesktopCommandId[] = [
  "workspace.choose",
  "session.new",
  "session.open",
  "composer.focus",
  "session.jump",
  "session.history",
  "session.modelThinking",
  "session.activity",
];

export function desktopCommandDefinition(id: DesktopCommandId): DesktopCommandDefinition {
  return DEFINITIONS[id];
}

export function isDesktopCommandId(value: string): value is DesktopCommandId {
  return Object.prototype.hasOwnProperty.call(DEFINITIONS, value);
}

export function desktopShortcutLabel(
  shortcut: DesktopShortcut | undefined,
  platform: DesktopShortcutPlatform,
): string | undefined {
  if (!shortcut) return undefined;
  const key = displayKey(shortcut.key);
  if (platform === "mac") {
    return `${shortcut.primary ? "⌘" : ""}${shortcut.alt ? "⌥" : ""}${shortcut.shift ? "⇧" : ""}${key}`;
  }
  return [
    shortcut.primary ? "Ctrl" : "",
    shortcut.alt ? "Alt" : "",
    shortcut.shift ? "Shift" : "",
    key,
  ].filter(Boolean).join("+");
}

export function desktopCommandShortcutLabel(
  id: DesktopCommandId,
  platform: DesktopShortcutPlatform,
): string | undefined {
  return desktopShortcutLabel(DEFINITIONS[id].shortcut, platform);
}

export function matchesDesktopShortcut(
  event: KeyboardShortcutEvent,
  shortcut: DesktopShortcut | undefined,
  platform: DesktopShortcutPlatform,
): boolean {
  if (!shortcut) return false;
  const primaryDown = platform === "mac" ? event.metaKey : event.ctrlKey;
  const unusedPrimaryDown = platform === "mac" ? event.ctrlKey : event.metaKey;
  if (Boolean(shortcut.primary) !== primaryDown || unusedPrimaryDown) return false;
  if (Boolean(shortcut.shift) !== event.shiftKey) return false;
  if (Boolean(shortcut.alt) !== event.altKey) return false;
  return event.key.toLowerCase() === shortcut.key.toLowerCase();
}

function displayKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  switch (key.toLowerCase()) {
    case "escape": return "Esc";
    case "arrowup": return "↑";
    case "arrowdown": return "↓";
    case "arrowleft": return "←";
    case "arrowright": return "→";
    default: return key;
  }
}
