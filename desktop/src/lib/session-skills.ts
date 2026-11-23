import type { TranscriptItem } from "./transcript-types";

export type SessionSkillsResult = { names: string[]; source: "file" | "chat" | "error" };
export type FindSessionSkills = (sessionId: string, signal: AbortSignal) => Promise<SessionSkillsResult>;

/** Collect observed loads from the transcript already in memory, in transcript order. */
export function loadedSessionSkills(items: readonly TranscriptItem[]): string[] {
  const names = new Set<string>();
  for (const item of items) {
    if (item.type === "tool") {
      if (item.status === "completed" && item.skillName) names.add(item.skillName);
    } else if (item.role === "user" && !item.localOnly && item.text.startsWith('<skill name="')) {
      // Pi's expanded /skill command, not an unexpanded command typed in the composer.
      const name = /^<skill name="([^"\r\n]+)" location="[^"\r\n]+">\n/.exec(item.text)?.[1];
      if (name && item.text.includes("\n</skill>")) names.add(name);
    }
  }
  return [...names];
}
