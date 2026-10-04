import type { SettingsConfigKind } from "./settings";

export const SETTINGS_GROUPS = {
  desktop: { label: "Desktop", sections: [
    { id: "general", label: "General" }, { id: "models", label: "Models" },
    { id: "assistant", label: "Assistant" }, { id: "observer", label: "Observer" }, { id: "voice", label: "Voice" },
    { id: "editor", label: "Editor" }, { id: "source-control", label: "Git" },
    { id: "advanced", label: "Advanced" },
  ] },
  "pi-tools-suite": { label: "Tools Suite", sections: [
    { id: "general", label: "General" }, { id: "subagents", label: "Sub-agents" },
    { id: "automation", label: "Automation" }, { id: "dcp", label: "DCP" },
    { id: "context", label: "Context" }, { id: "integrations", label: "Integrations" },
    { id: "advanced", label: "Advanced" },
  ] },
} as const satisfies Record<SettingsConfigKind, { label: string; sections: readonly { id: string; label: string }[] }>;

export function settingsSearchMatches(query: string, text: string): boolean {
  const haystack = text.toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/u).every((word) => haystack.includes(word));
}

export function currentSettingsSection(sections: readonly { id: string; top: number }[], threshold: number, atEnd: boolean): string {
  if (atEnd) return sections.at(-1)?.id ?? "";
  let current = sections[0]?.id ?? "";
  for (const section of sections) {
    if (section.top > threshold) break;
    current = section.id;
  }
  return current;
}
