import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import htmlSandboxExtension from "../src/bundled-extensions/html-sandbox/index.js";
import {
	advertiseHtmlSandbox,
	HTML_SANDBOX_CAPABILITY_MARKER,
	HTML_SANDBOX_GUIDE,
	HTML_SANDBOX_TOOL_DESCRIPTION,
} from "../src/bundled-extensions/html-sandbox/guide.js";

function extensionHarness() {
	const tools: Array<{
		name: string;
		description: string;
		execute: () => Promise<{ content: Array<{ type: string; text: string }> }>;
	}> = [];
	let beforeAgentStart: ((event: { systemPrompt: string }, ctx: { mode: string }) => unknown) | undefined;
	const pi = {
		registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
		on: (name: string, callback: typeof beforeAgentStart) => {
			assert.equal(name, "before_agent_start");
			beforeAgentStart = callback;
		},
	} as unknown as ExtensionAPI;
	htmlSandboxExtension(pi);
	assert.ok(beforeAgentStart);
	return { tools, beforeAgentStart };
}

test("Desktop agent sees a concise capability note, without consuming the full guide", () => {
	const { tools, beforeAgentStart } = extensionHarness();
	assert.equal(tools.length, 1);
	const result = beforeAgentStart!({ systemPrompt: "You are a code agent." }, { mode: "rpc" }) as { systemPrompt: string };
	assert.match(result.systemPrompt, /Pix Desktop interactive chat UI/);
	assert.match(result.systemPrompt, /pix_html_sandbox_guide/);
	assert.match(result.systemPrompt, /pix-html/);
	assert.match(result.systemPrompt, /in chat/);
	assert.match(result.systemPrompt, /в чате/);
	assert.doesNotMatch(result.systemPrompt, /<form>|<canvas>|<script>|scrollbar/);
	assert.equal(advertiseHtmlSandbox(result.systemPrompt), result.systemPrompt, "capability must not duplicate");
	assert.equal(result.systemPrompt.match(/\[Pix Desktop interactive chat UI\]/g)?.length, 1);
});

test("the loaded extension leaves TUI prompts unchanged and serves details only on demand", async () => {
	const { tools, beforeAgentStart } = extensionHarness();
	assert.equal(beforeAgentStart!({ systemPrompt: "Base" }, { mode: "tui" }), undefined);
	assert.match(tools[0]!.description, /interactive/);
	assert.equal(tools[0]!.description, HTML_SANDBOX_TOOL_DESCRIPTION);
	const result = await tools[0]!.execute();
	assert.match(result.content[0]!.text, /```pix-html/);
	assert.match(result.content[0]!.text, /window\.pix\.submit/);
	assert.match(result.content[0]!.text, /addEventListener/);
	assert.match(result.content[0]!.text, /Run/);
	assert.match(result.content[0]!.text, /Tetris in chat/);
	assert.equal(result.content[0]!.text, HTML_SANDBOX_GUIDE);
	assert.ok(HTML_SANDBOX_CAPABILITY_MARKER.length < 60, "the permanent marker stays short");
});

test("routing distinguishes working inline UI from files, static visuals and discussion", () => {
	const prompt = advertiseHtmlSandbox("Base");
	assert.match(prompt, /use pix-html rather than creating a standalone file/);
	assert.match(prompt, /unless they explicitly request a file\/project change/);
	assert.match(prompt, /MUST call pix_html_sandbox_guide/);
	assert.match(prompt, /If present, follow them directly and DO NOT call the guide again/);
	assert.match(prompt, /Do not call the guide merely to discuss this capability/);
	assert.match(prompt, /Prefer SVG for static visual explanations/);
	assert.match(prompt, /explain the limitation and offer an alternative/);
	assert.match(HTML_SANDBOX_TOOL_DESCRIPTION, /ONLY if the full guide is absent/);
	assert.match(HTML_SANDBOX_TOOL_DESCRIPTION, /not for discussing the feature/);
});

test("guide ships pinned engine references and routing without enabling network imports", () => {
	const pkg = JSON.parse(readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8"));
	assert.match(advertiseHtmlSandbox("Base"), /live animation, 2D\/3D scene/);
	assert.match(advertiseHtmlSandbox("Base"), /locally packaged Phaser \(2D\) \/ Three.js \(3D\)/);
	assert.ok(HTML_SANDBOX_GUIDE.includes(`Phaser ${pkg.dependencies.phaser}`));
	assert.ok(HTML_SANDBOX_GUIDE.includes(`Three.js ${pkg.dependencies.three}`));
	assert.match(HTML_SANDBOX_GUIDE, /<script src="pix:phaser"><\/script>/);
	assert.match(HTML_SANDBOX_GUIDE, /<script src="pix:three"><\/script>/);
	assert.match(HTML_SANDBOX_GUIDE, /Phaser\.CANVAS/);
	assert.match(HTML_SANDBOX_GUIDE, /THREE\.WebGLRenderer/);
	assert.match(HTML_SANDBOX_GUIDE, /WebGL2 is unavailable/);
	assert.match(HTML_SANDBOX_GUIDE, /No Three.js addons/);
	assert.match(HTML_SANDBOX_GUIDE, /No CDN imports/);
	assert.match(HTML_SANDBOX_TOOL_DESCRIPTION, /engine references/);
});
