import assert from "node:assert/strict";
import { describe, it } from "node:test";

import choiceActionsExtension, { CHOICE_ACTIONS_WIDGET_KEY, finalAssistantText, latestRunChoiceActions } from "../src/bundled-extensions/choice-actions/index.js";
import { CHOICE_ACTIONS_CAPABILITY, CHOICE_ACTIONS_CAPABILITY_MARKER, lastChoiceActions } from "../src/bundled-extensions/choice-actions/contract.js";
import { renderMarkdownTextLines } from "../src/markdown-format.js";

type Handler = (event: any, ctx: any) => any;

function harness(mode: "tui" | "rpc" = "tui") {
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const widgets: (string[] | undefined)[] = [];
	const notices: string[] = [];
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let editorText = "";
	const pi = {
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		sendUserMessage(text: string) { sent.push(text); },
	};
	const ctx = {
		mode,
		hasUI: true,
		ui: {
			setWidget(key: string, content: string[] | undefined) { assert.equal(key, CHOICE_ACTIONS_WIDGET_KEY); widgets.push(content); },
			onTerminalInput(handler: typeof inputHandler) { inputHandler = handler; return () => { if (inputHandler === handler) inputHandler = undefined; }; },
			getEditorText: () => editorText,
			notify: (message: string) => { notices.push(message); },
		},
	};
	choiceActionsExtension(pi as never);
	const emit = (event: string, payload: unknown = {}) => (handlers.get(event) ?? []).map((handler) => handler(payload, ctx));
	return {
		emit, sent, widgets, notices,
		key: (data: string) => inputHandler?.(data),
		get subscribed() { return inputHandler !== undefined; },
		setEditor(text: string) { editorText = text; },
	};
}

const reply = (text: string) => ({ messages: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "text", text }] }] });
const block = "Done.\n```pix-actions Next\n- [x] Add tests\n- [ ] Update docs\n```";

describe("pix-actions contract", () => {
	it("advertises a valid single-action example with the button label on the opening line", () => {
		assert.deepEqual(lastChoiceActions(CHOICE_ACTIONS_CAPABILITY), {
			submitLabel: "Simplify",
			items: [{ label: "Remove duplicate instructions", checked: true }],
		});
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes("MUST be on the opening line, never inside the body"));
	});

	it("requires a closed pix-actions fence for reply buttons and demonstrates it", () => {
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes('use a closed ```pix-actions fence containing 1–4 plain "- Done" lines'));
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes("An unfenced Markdown list stays ordinary text, not buttons."));
		const examples = [...CHOICE_ACTIONS_CAPABILITY.matchAll(/^```pix-actions[^\n]*\n[\s\S]*?\n```/gm)].map(([text]) => lastChoiceActions(text));
		assert.equal(examples.length, 2);
		assert.deepEqual(examples[0], {
			submitLabel: "Continue",
			items: [{ label: "Done", checked: false }, { label: "Error loading extension", checked: false }],
			buttons: true,
		});
		assert.equal(examples[1]?.items[0]?.checked, true);
	});

	it("briefly rejects JSON actions and premature prerequisites", () => {
		const guidance = "No JSON or label/prompt objects: each item is the full instruction to send, with prerequisites already satisfied.";
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes(guidance));
		assert.ok(guidance.split(/\s+/).length <= 22);
	});

	it("does not re-open supplied completed work merely to offer optional next steps", () => {
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes("from supplied completed-work context"));
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes("without extra tool calls or re-checking the work"));
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes("not lost-context recovery or task execution"));
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes("do not inspect session history, todo state, or the repository"));
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes("Summarize only supplied facts"));
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes("offering a next step is not authorization to start it"));
	});

	it("rejects a standalone button label in the body instead of treating it as an action", () => {
		assert.equal(lastChoiceActions("```pix-actions\nУпростить\n- [x] Убрать дублирующую маршрутизацию к скиллам из AGENTS.md\n```"), undefined);
		assert.equal(lastChoiceActions("```pix-actions Упростить\n- [x] Убрать дублирующую маршрутизацию к скиллам из AGENTS.md\n```")?.submitLabel, "Упростить");
	});

	it("finds the last valid closed block and ignores malformed or open ones", () => {
		assert.deepEqual(lastChoiceActions(block)?.items.map((item) => item.label), ["Add tests", "Update docs"]);
		assert.equal(lastChoiceActions("```pix-actions\n- [x] A\nplain\n```"), undefined);
		assert.equal(lastChoiceActions("```pix-actions\n- [x] A"), undefined);
		assert.equal(lastChoiceActions(`${block}\n\`\`\`pix-actions Later\n- [ ] Z\n\`\`\``)?.submitLabel, "Later");
		assert.equal(lastChoiceActions("````md\n```pix-actions\n- [x] A\n```\n````"), undefined);
	});

	it("reads the final assistant text only when no user message follows", () => {
		assert.equal(finalAssistantText(reply("hi").messages), "hi");
		assert.equal(finalAssistantText([{ role: "assistant", content: "x" }, { role: "user", content: "y" }]), undefined);
	});

	it("keeps a checklist the agent offered before it kept working", () => {
		const kept = [{ role: "user", content: "go" }, { role: "assistant", content: block }, { role: "toolResult", content: "ok" }, { role: "assistant", content: "Continuing." }];
		assert.equal(latestRunChoiceActions(kept)?.submitLabel, "Next");
		assert.equal(latestRunChoiceActions([...kept, { role: "user", content: "x" }]), undefined);
		assert.equal(latestRunChoiceActions([{ role: "assistant", content: block }, { role: "user", content: "x" }, { role: "assistant", content: "plain" }]), undefined);
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes("no tool calls or further work after it"));
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes("one-click reply button"));
		assert.ok(CHOICE_ACTIONS_CAPABILITY.includes("verify it actually ends with the complete closed pix-actions fence"));
	});
});

describe("pix-actions TUI extension", () => {
	it("advertises the rule only in TUI mode, once", () => {
		const tui = harness("tui");
		const [result] = tui.emit("before_agent_start", { systemPrompt: "base" });
		assert.ok(result.systemPrompt.includes(CHOICE_ACTIONS_CAPABILITY_MARKER));
		assert.equal(tui.emit("before_agent_start", { systemPrompt: result.systemPrompt })[0], undefined);
		assert.equal(harness("rpc").emit("before_agent_start", { systemPrompt: "base" })[0], undefined);
	});

	it("toggles with digits and submits the selection on Enter", () => {
		const h = harness();
		h.emit("agent_end", reply(block));
		assert.deepEqual(h.widgets[h.widgets.length - 1]?.slice(0, 2), ["☑ 1. Add tests", "☐ 2. Update docs"]);
		assert.deepEqual(h.key("2"), { consume: true });
		assert.deepEqual(h.key("1"), { consume: true });
		assert.deepEqual(h.key("9"), { consume: true });
		assert.deepEqual(h.key("\r"), { consume: true });
		assert.deepEqual(h.sent, ["Next:\n2. Update docs"]);
		assert.equal(h.widgets[h.widgets.length - 1], undefined);
		assert.equal(h.subscribed, false);
	});

	it("refuses an empty submission", () => {
		const h = harness();
		h.emit("agent_end", reply(block));
		h.key("1");
		h.key("\r");
		assert.deepEqual(h.sent, []);
		assert.equal(h.notices.length, 1);
		assert.equal(h.subscribed, true);
	});

	it("yields to a non-empty draft and dismisses when typing or on Esc", () => {
		const h = harness();
		h.emit("agent_end", reply(block));
		h.setEditor("hello");
		assert.equal(h.key("1"), undefined);
		assert.equal(h.key("\r"), undefined);
		h.setEditor("");
		assert.equal(h.key("a"), undefined);
		assert.equal(h.subscribed, false);
		assert.deepEqual(h.sent, []);

		h.emit("agent_end", reply(block));
		assert.deepEqual(h.key("\u001b"), { consume: true });
		assert.equal(h.subscribed, false);
		assert.equal(h.key("\u0003"), undefined);
	});

	it("clears on a new run or session and ignores replies without a block", () => {
		const h = harness();
		h.emit("agent_end", reply(block));
		h.emit("agent_start");
		assert.equal(h.subscribed, false);
		h.emit("agent_end", reply(block));
		h.emit("session_start");
		assert.equal(h.subscribed, false);
		h.emit("agent_end", reply("no choices here"));
		assert.equal(h.subscribed, false);
		const rpc = harness("rpc");
		rpc.emit("agent_end", reply(block));
		assert.equal(rpc.subscribed, false);
	});
});

describe("pix-actions TUI reply buttons", () => {
	const buttons = "Install it, then reply.\n```pix-actions\n- Готово\n- Пропустить\n```";

	it("sends a button label on its digit and ignores other keys", () => {
		const h = harness();
		h.emit("agent_end", reply(buttons));
		assert.deepEqual(h.widgets[h.widgets.length - 1], ["[1] Готово  [2] Пропустить", "1–2 send · Esc dismiss · type to write your own"]);
		assert.deepEqual(h.key("\r"), { consume: true });
		assert.deepEqual(h.key("3"), { consume: true });
		assert.deepEqual(h.sent, []);
		assert.deepEqual(h.key("2"), { consume: true });
		assert.deepEqual(h.sent, ["Пропустить"]);
		assert.equal(h.subscribed, false);
	});

	it("sends a single button on Enter", () => {
		const h = harness();
		h.emit("agent_end", reply("Do it.\n```pix-actions\n- Готово\n```"));
		assert.deepEqual(h.key("\r"), { consume: true });
		assert.deepEqual(h.sent, ["Готово"]);
	});
});

describe("pix-actions transcript rendering", () => {
	it("renders a valid block as a checklist and keeps malformed blocks as code", () => {
		const lines = renderMarkdownTextLines(block, 80).map((line) => line.text);
		assert.deepEqual(lines, ["Done.", "☑ 1. Add tests", "☐ 2. Update docs", "↳ Next"]);
		assert.deepEqual(renderMarkdownTextLines("Ready?\n```pix-actions\n- Готово\n- Пропустить\n```", 80).map((line) => line.text), ["Ready?", "[ Готово ]  [ Пропустить ]"]);
		const malformed = renderMarkdownTextLines("```pix-actions\n- [x] A\nplain\n```", 80);
		assert.ok(malformed.every((line) => line.codeBlock));
	});
});
