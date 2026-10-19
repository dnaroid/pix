import assert from "node:assert/strict";
import { describe, it } from "node:test";

import choiceActionsExtension, { CHOICE_ACTIONS_WIDGET_KEY, finalAssistantText } from "../src/bundled-extensions/choice-actions/index.js";
import { CHOICE_ACTIONS_CAPABILITY_MARKER, lastChoiceActions } from "../src/bundled-extensions/choice-actions/contract.js";
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

describe("pix-actions transcript rendering", () => {
	it("renders a valid block as a checklist and keeps malformed blocks as code", () => {
		const lines = renderMarkdownTextLines(block, 80).map((line) => line.text);
		assert.deepEqual(lines, ["Done.", "☑ 1. Add tests", "☐ 2. Update docs", "↳ Next"]);
		const malformed = renderMarkdownTextLines("```pix-actions\n- [x] A\nplain\n```", 80);
		assert.ok(malformed.every((line) => line.codeBlock));
	});
});
