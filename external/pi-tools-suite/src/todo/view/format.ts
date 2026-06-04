import { formatStatusLabel } from "./labels.js";
import type { Task } from "../tool/types.js";

// Re-export so legacy import paths (todo.ts, tests) continue to resolve.
export { formatStatusLabel };

/**
 * Format a single task line for the `/todos` slash command (no glyph color,
 * indented bullet prefix). Pre-refactor `todo.ts:670-674`.
 */
export function formatCommandTaskLine(t: Task, glyph: string): string {
	const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
	const priority = t.priority ? ` (${t.priority})` : "";
	const thinking = t.thinking ? ` {thinking:${t.thinking}}` : "";
	const parent = t.parentId !== undefined ? `    ↳ #${t.parentId}` : "";
	const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const tags = t.tags?.length ? `    ${t.tags.map((tag) => `#${tag}`).join(" ")}` : "";
	return `  ${glyph} #${t.id} ${t.subject}${priority}${thinking}${form}${parent}${block}${tags}`;
}
