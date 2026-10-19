// Model-authored quick-choice blocks: a closed ```pix-actions fence whose body
// is a GFM task list. Shared by Pix Desktop and the Pix TUI; no runtime deps.

export const CHOICE_ACTIONS_LANGUAGE = "pix-actions";
export const MIN_CHOICE_ACTIONS = 1;
export const MAX_CHOICE_ACTIONS = 8;
export const MAX_CHOICE_ACTION_CHARS = 300;
export const MAX_CHOICE_SUBMIT_LABEL_CHARS = 40;
export const DEFAULT_CHOICE_SUBMIT_LABEL = "Continue";

/** Prompt guidance shared by every client that renders pix-actions. */
export const CHOICE_ACTIONS_CAPABILITY = "Choice rule: if you need the user's answer before you can continue, call the question tool and wait; if the work is done and you are only offering optional next steps, end the turn with a pix-actions checklist instead. Never use both for the same choice.\n"
	+ "When ending with one or more next steps that you would carry out, add a ```pix-actions <button label> fence with one \"- [x] step\" (recommended) or \"- [ ] step\" line each; the user can tick several. Keep steps the user must do themselves as plain text.";
export const CHOICE_ACTIONS_CAPABILITY_MARKER = "Choice rule: if you need the user's answer";

export interface ChoiceActionItem {
	readonly label: string;
	readonly checked: boolean;
}

export interface ChoiceActions {
	readonly submitLabel: string;
	readonly items: readonly ChoiceActionItem[];
}

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.+?)\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

export function isChoiceActionsInfo(info: string): boolean {
	return info.trim().split(/\s+/, 1)[0] === CHOICE_ACTIONS_LANGUAGE;
}

/**
 * Returns undefined for anything that is not a well-formed block, so the
 * caller can keep it as an ordinary (escaped) code fence.
 */
export function parseChoiceActions(info: string, body: string): ChoiceActions | undefined {
	const items: ChoiceActionItem[] = [];
	for (const line of body.split("\n")) {
		if (!line.trim()) continue;
		const match = line.match(ITEM);
		if (!match?.[2] || match[2].length > MAX_CHOICE_ACTION_CHARS) return undefined;
		items.push({ label: match[2], checked: match[1] !== " " });
	}
	if (items.length < MIN_CHOICE_ACTIONS || items.length > MAX_CHOICE_ACTIONS) return undefined;
	const rawLabel = info.trim().replace(/^\S+\s*/, "").replace(/^(["'])(.*)\1$/, "$2").trim();
	const submitLabel = rawLabel && rawLabel.length <= MAX_CHOICE_SUBMIT_LABEL_CHARS
		? rawLabel
		: DEFAULT_CHOICE_SUBMIT_LABEL;
	return { submitLabel, items };
}

/** The user message sent when the choices are submitted. */
export function choiceActionsPrompt(submitLabel: string, items: readonly ChoiceActionItem[], selected: readonly number[]): string {
	const lines = [...new Set(selected)]
		.filter((index) => index >= 0 && index < items.length)
		.sort((a, b) => a - b)
		.map((index) => `${index + 1}. ${items[index]!.label}`);
	if (!lines.length) throw new Error("Select at least one option.");
	return `${submitLabel}:\n${lines.join("\n")}`;
}

/** The last closed, valid top-level pix-actions block in Markdown text. */
export function lastChoiceActions(text: string): ChoiceActions | undefined {
	const lines = text.split("\n");
	let found: ChoiceActions | undefined;
	for (let index = 0; index < lines.length; index += 1) {
		const open = FENCE.exec(lines[index] ?? "");
		if (!open?.[1]) continue;
		const marker = open[1];
		let close = index + 1;
		for (; close < lines.length; close += 1) {
			const candidate = FENCE.exec(lines[close] ?? "");
			if (candidate?.[1] && candidate[1][0] === marker[0] && candidate[1].length >= marker.length && !candidate[2]?.trim()) break;
		}
		if (close >= lines.length) break;
		if (isChoiceActionsInfo(open[2] ?? "")) {
			found = parseChoiceActions(open[2] ?? "", lines.slice(index + 1, close).join("\n")) ?? found;
		}
		index = close;
	}
	return found;
}
