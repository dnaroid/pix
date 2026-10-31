import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHOICE_ACTIONS_CAPABILITY, CHOICE_ACTIONS_CAPABILITY_MARKER, choiceActionsPrompt, lastChoiceActions, type ChoiceActions } from "./contract.js";

export const CHOICE_ACTIONS_WIDGET_KEY = "pix-actions";

type ActiveChoice = {
	readonly ctx: ExtensionContext;
	readonly actions: ChoiceActions;
	readonly selected: Set<number>;
	unsubscribe?: () => void;
};

/** Text of the final assistant message in an agent run. */
export function finalAssistantText(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
		if (message?.role === "user") return undefined;
		if (message?.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return undefined;
		return message.content
			.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}
	return undefined;
}

/**
 * The latest valid checklist an agent run offered since the last user message.
 * The agent may keep working after offering one; later block-less replies
 * must not make it unreachable.
 */
export function latestRunChoiceActions(messages: readonly unknown[]): ChoiceActions | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: unknown } | undefined;
		if (message?.role === "user") return undefined;
		if (message?.role !== "assistant") continue;
		const text = finalAssistantText([message]);
		const actions = text ? lastChoiceActions(text) : undefined;
		if (actions) return actions;
	}
	return undefined;
}

export function renderChoiceActionsWidget(actions: ChoiceActions, selected: ReadonlySet<number>): string[] {
	return [
		...actions.items.map((item, index) => `${selected.has(index) ? "☑" : "☐"} ${index + 1}. ${item.label}`),
		`1–${actions.items.length} toggle · Enter: ${actions.submitLabel} · Esc dismiss · type to write your own`,
	];
}

/**
 * TUI-only: advertises pix-actions and turns the latest block into a
 * non-blocking checklist above an empty editor. Desktop renders its own UI.
 */
export default function choiceActionsExtension(pi: ExtensionAPI): void {
	let active: ActiveChoice | undefined;

	function hide(): void {
		const current = active;
		if (!current) return;
		active = undefined;
		current.unsubscribe?.();
		try { current.ctx.ui.setWidget(CHOICE_ACTIONS_WIDGET_KEY, undefined); } catch { /* Superseded UI scope. */ }
	}

	function render(current: ActiveChoice): void {
		try {
			current.ctx.ui.setWidget(CHOICE_ACTIONS_WIDGET_KEY, renderChoiceActionsWidget(current.actions, current.selected), { placement: "aboveEditor" });
		} catch { hide(); }
	}

	function handleInput(current: ActiveChoice, data: string): { consume?: boolean } | undefined {
		if (active !== current || data === "\u0003") return undefined;
		// A non-empty draft owns every key; the checklist only reacts to an empty composer.
		if (current.ctx.ui.getEditorText() !== "") return undefined;
		if (/^[1-9]$/.test(data)) {
			const index = Number(data) - 1;
			if (index >= current.actions.items.length) return { consume: true };
			if (current.selected.has(index)) current.selected.delete(index);
			else current.selected.add(index);
			render(current);
			return { consume: true };
		}
		if (data === "\r" || data === "\n") {
			if (current.selected.size === 0) {
				current.ctx.ui.notify("Select at least one option.", "info");
				return { consume: true };
			}
			const prompt = choiceActionsPrompt(current.actions.submitLabel, current.actions.items, [...current.selected]);
			hide();
			pi.sendUserMessage(prompt);
			return { consume: true };
		}
		if (data === "\u001b") { hide(); return { consume: true }; }
		// Typing a custom reply dismisses the checklist and keeps the keystroke.
		if (data.length === 1 && data >= " " && data !== "\u007f") hide();
		return undefined;
	}

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.mode !== "tui" || event.systemPrompt.includes(CHOICE_ACTIONS_CAPABILITY_MARKER)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${CHOICE_ACTIONS_CAPABILITY}` };
	});

	pi.on("agent_start", () => hide());
	pi.on("input", () => { hide(); return { action: "continue" as const }; });
	pi.on("session_start", () => hide());
	pi.on("session_shutdown", () => hide());

	pi.on("agent_end", (event, ctx) => {
		hide();
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const actions = latestRunChoiceActions(event.messages);
		if (!actions) return;
		const selected = new Set(actions.items.flatMap((item, index) => item.checked ? [index] : []));
		const current: ActiveChoice = { ctx, actions, selected };
		active = current;
		current.unsubscribe = ctx.ui.onTerminalInput((data) => handleInput(current, data));
		render(current);
	});
}
