import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

import { MockModel } from "../tests/helpers/mock-model.js";

const exec = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");
const outputDir = join(projectRoot, "assets", "screenshots");
const socketName = `pix-readme-${process.pid}`;
const sessionName = "pix-readme";
const rows = 26;
const cols = 124;

const fixtureExtension = `
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";

export default function readmeScreenshotFixtures(pi) {
	pi.registerTool({
		name: "todo",
		label: "Adaptive Todo",
		description: "Return a deterministic implementation plan for README screenshots.",
		parameters: Type.Object({ action: Type.String() }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: "Plan synchronized: 1 complete, 2 active, 2 blocked." }],
				details: {
					action: params.action,
					params,
					nextId: 6,
					tasks: [
						{ id: 5, subject: "Harden expired sessions", status: "in_progress", activeForm: "hardening expired sessions", thinking: "high" },
						{ id: 1, parentId: 5, subject: "Trace the session boundary", status: "completed", thinking: "high" },
						{ id: 2, parentId: 5, subject: "Add expiry regression coverage", status: "in_progress", activeForm: "writing expiry regression tests", thinking: "high", owner: "test-review" },
						{ id: 3, parentId: 5, subject: "Guard the refresh path", status: "pending", blockedBy: [2], thinking: "medium" },
						{ id: 4, parentId: 5, subject: "Run focused checks", status: "pending", blockedBy: [3], thinking: "low" },
					],
				},
			};
		},
	});

	pi.registerTool({
		name: "subagents",
		label: "Parallel Sub-agents",
		description: "Return deterministic parallel-agent state for README screenshots.",
		parameters: Type.Object({ action: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runId = "readme-parallel-audit";
			const runDir = join(ctx.cwd, ".pi", "subagents", runId);
			const sessionFile = ctx.sessionManager?.getSessionFile?.();
			const agentIds = ["code-map", "test-review", "ux-audit"];
			if (sessionFile) {
				for (const agentId of agentIds) {
					const agentDir = join(runDir, agentId);
					await mkdir(agentDir, { recursive: true });
					await writeFile(join(agentDir, "prompt.md"), "README screenshot fixture");
					await writeFile(join(agentDir, "parent_session"), sessionFile);
					if (agentId === "code-map") await writeFile(join(agentDir, "exit_code"), "0");
					else await writeFile(join(agentDir, "pid"), String(process.pid));
				}
				const updatedAt = "2026-07-20T19:00:00.000Z";
				const registryRun = { runId, runDir, agentIds, createdAt: updatedAt, updatedAt };
				await writeFile(join(ctx.cwd, ".pi", "subagents", "registry.json"), JSON.stringify({
					version: 1,
					latestRunId: runId,
					latestRunDir: runDir,
					runs: { [runId]: registryRun },
					agents: Object.fromEntries(agentIds.map((agentId) => [agentId, { agentId, runId, runDir, updatedAt }])),
				}));
			}
			return {
				content: [{ type: "text", text: "Parallel review started: 2 running, 1 completed." }],
				details: {
					mode: params.action,
					runDir,
					agents: [
						{ id: "code-map", status: "done", exitCode: 0 },
						{ id: "test-review", status: "running", pid: 41231 },
						{ id: "ux-audit", status: "running", pid: 41232 },
					],
					tasks: [
						{ id: "code-map", model: "gpt-5.4-mini", task: "Trace refresh and persistence boundaries" },
						{ id: "test-review", model: "claude-sonnet-4-6", task: "Design expiry and race regression cases" },
						{ id: "ux-audit", model: "gemini-3.1-pro", task: "Review user-visible recovery states" },
					],
				},
			};
		},
	});
}
`;

type Style = {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	foreground?: string;
	background?: string;
};

type Segment = { text: string; style: Style };

const basicColors = [
	"#1f2430", "#ff6b6b", "#7bd88f", "#ffd866", "#6cb6ff", "#c792ea", "#66d9ef", "#d8dee9",
	"#5c6370", "#ff8f8f", "#a7e8af", "#ffe69a", "#9dcbff", "#ddb6f2", "#9be7f5", "#ffffff",
];

async function tmux(...args: string[]): Promise<string> {
	const { stdout } = await exec("tmux", ["-L", socketName, ...args], {
		cwd: projectRoot,
		maxBuffer: 10 * 1024 * 1024,
	});
	return stdout;
}

async function capture(ansi: boolean): Promise<string> {
	return tmux("capture-pane", "-p", ...(ansi ? ["-e"] : []), "-N", "-t", sessionName);
}

async function waitFor(text: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await capture(false)).includes(text)) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	throw new Error(`Timed out waiting for ${JSON.stringify(text)}\n\n${await capture(false)}`);
}

async function send(text: string): Promise<void> {
	await tmux("send-keys", "-t", sessionName, "-l", text);
}

async function sendEscape(): Promise<void> {
	await send("\x1b[27u");
	await new Promise((resolveWait) => setTimeout(resolveWait, 150));
}

async function clickNewTab(): Promise<void> {
	const firstLine = (await capture(false)).split("\n")[0] ?? "";
	const markerIndex = firstLine.indexOf("󰐕");
	if (markerIndex < 0) throw new Error(`Could not find the new-tab button:\n${firstLine}`);
	const column = Array.from(firstLine.slice(0, markerIndex)).length + 1;
	await send(`\x1b[<0;${column};1M\x1b[<0;${column};1m`);
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const nextFirstLine = (await capture(false)).split("\n")[0] ?? "";
		if (nextFirstLine !== firstLine) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 500));
			return;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	throw new Error(`Timed out opening a new tab:\n${await capture(false)}`);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function defaultStyle(): Style {
	return { bold: false, dim: false, italic: false, underline: false, inverse: false };
}

function cloneStyle(style: Style): Style {
	return { ...style };
}

function parseAnsiLine(line: string): Segment[] {
	const segments: Segment[] = [];
	let style = defaultStyle();
	let cursor = 0;
	const expression = /\x1b\[([0-9;:]*)m/gu;
	for (const match of line.matchAll(expression)) {
		const index = match.index ?? 0;
		if (index > cursor) segments.push({ text: line.slice(cursor, index), style: cloneStyle(style) });
		style = applySgr(style, match[1] ?? "");
		cursor = index + match[0].length;
	}
	if (cursor < line.length) segments.push({ text: line.slice(cursor), style: cloneStyle(style) });
	return segments;
}

function applySgr(current: Style, raw: string): Style {
	let style = cloneStyle(current);
	const codes = raw === "" ? [0] : raw.split(/[;:]/u).map((value) => Number(value || 0));
	for (let index = 0; index < codes.length; index += 1) {
		const code = codes[index] ?? 0;
		if (code === 0) style = defaultStyle();
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 3) style.italic = true;
		else if (code === 4) style.underline = true;
		else if (code === 7) style.inverse = true;
		else if (code === 22) { style.bold = false; style.dim = false; }
		else if (code === 23) style.italic = false;
		else if (code === 24) style.underline = false;
		else if (code === 27) style.inverse = false;
		else if (code >= 30 && code <= 37) style.foreground = basicColors[code - 30];
		else if (code >= 90 && code <= 97) style.foreground = basicColors[code - 90 + 8];
		else if (code >= 40 && code <= 47) style.background = basicColors[code - 40];
		else if (code >= 100 && code <= 107) style.background = basicColors[code - 100 + 8];
		else if (code === 39) style.foreground = undefined;
		else if (code === 49) style.background = undefined;
		else if ((code === 38 || code === 48) && codes[index + 1] === 5) {
			const color = xtermColor(codes[index + 2] ?? 0);
			if (code === 38) style.foreground = color;
			else style.background = color;
			index += 2;
		} else if ((code === 38 || code === 48) && codes[index + 1] === 2) {
			const color = `rgb(${codes[index + 2] ?? 0},${codes[index + 3] ?? 0},${codes[index + 4] ?? 0})`;
			if (code === 38) style.foreground = color;
			else style.background = color;
			index += 4;
		}
	}
	return style;
}

function xtermColor(index: number): string {
	if (index < 16) return basicColors[index] ?? basicColors[7]!;
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return `rgb(${level},${level},${level})`;
	}
	const value = index - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	const red = levels[Math.floor(value / 36)] ?? 0;
	const green = levels[Math.floor((value % 36) / 6)] ?? 0;
	const blue = levels[value % 6] ?? 0;
	return `rgb(${red},${green},${blue})`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;");
}

function styleAttributes(style: Style): string {
	const foreground = style.inverse ? style.background ?? "#171b24" : style.foreground ?? "#d8dee9";
	return [
		`fill="${foreground}"`,
		style.bold ? 'font-weight="700"' : "",
		style.italic ? 'font-style="italic"' : "",
		style.underline ? 'text-decoration="underline"' : "",
		style.dim ? 'opacity="0.62"' : "",
	].filter(Boolean).join(" ");
}

function backgroundColor(style: Style): string | undefined {
	return style.inverse ? style.foreground ?? "#d8dee9" : style.background;
}

function renderSvg(ansi: string, title: string): string {
	const fontSize = 13;
	const lineHeight = 18;
	const horizontalPadding = 22;
	const top = 48;
	const width = cols * 8 + horizontalPadding * 2;
	const height = rows * lineHeight + top + 18;
	const lines = ansi.replace(/\r/gu, "").split("\n").slice(0, rows);
	const parsedLines = lines.map(parseAnsiLine);
	const backgrounds = parsedLines.flatMap((segments, row) => {
		let column = 0;
		return segments.flatMap((segment) => {
			const segmentWidth = Array.from(segment.text).length;
			const background = backgroundColor(segment.style);
			const rectangle = background
				? [`<rect x="${horizontalPadding + column * 8}" y="${top + row * lineHeight + 4}" width="${segmentWidth * 8}" height="${lineHeight}" fill="${background}"/>`]
				: [];
			column += segmentWidth;
			return rectangle;
		});
	}).join("\n");
	const text = parsedLines.map((segments, row) => {
		const spans = segments
			.filter((segment) => segment.text.length > 0)
			.map((segment) => `<tspan ${styleAttributes(segment.style)}>${escapeXml(segment.text)}</tspan>`)
			.join("");
		return `<text x="${horizontalPadding}" y="${top + (row + 1) * lineHeight}" xml:space="preserve">${spans}</text>`;
	}).join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <rect width="${width}" height="${height}" rx="14" fill="#0f1218"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="13" fill="none" stroke="#303746"/>
  <circle cx="22" cy="22" r="6" fill="#ff5f57"/><circle cx="42" cy="22" r="6" fill="#febc2e"/><circle cx="62" cy="22" r="6" fill="#28c840"/>
  <text x="${width / 2}" y="27" text-anchor="middle" fill="#7f8797" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="12">${escapeXml(title)}</text>
  <g>${backgrounds}</g>
  <g font-family="JetBrainsMono Nerd Font Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${fontSize}" font-variant-ligatures="none">${text}</g>
</svg>
`;
}

async function writeScreenshot(fileName: string, ansi: string, title: string): Promise<void> {
	const svgPath = join(outputDir, `${fileName}.svg`);
	const pngPath = join(outputDir, `${fileName}.png`);
	await writeFile(svgPath, renderSvg(ansi, title));
	try {
		await exec("rsvg-convert", [svgPath, "-o", pngPath]);
	} catch {
		console.warn(`rsvg-convert not found; kept SVG only: ${svgPath}`);
	}
}

async function main(): Promise<void> {
	const tempDir = await mkdtemp(join(tmpdir(), "pix-readme-shot-"));
	const agentDir = join(tempDir, "agent");
	const workspace = join(tempDir, "workspace");
	const mockModel = await MockModel.start([
		{
			segments: [
				{ kind: "thinking", text: "I’ll inspect the authentication flow before changing anything." },
				{ kind: "text", text: "I’ll trace the session boundary and verify the current behavior first." },
				{ kind: "tool_use", name: "read", input: { path: "src/auth/session.ts" } },
			],
		},
		{
			segments: [{ kind: "text", text: "The refresh path is isolated in `loadSession()`. Next I’d add an expiry regression test, then make the smallest guarded change." }],
		},
		{
			segments: [
				{ kind: "thinking", text: "I’ll turn the investigation into a dependency-aware plan." },
				{ kind: "text", text: "I’ll keep the plan small and update it as each dependency clears." },
				{ kind: "tool_use", name: "todo", input: { action: "list" } },
			],
		},
		{
			segments: [{ kind: "text", text: "The implementation order is now explicit: coverage first, guarded change second, focused checks last." }],
		},
		{
			segments: [
				{ kind: "text", text: "I’ll split the independent review tracks and keep implementation in this session." },
				{ kind: "tool_use", name: "subagents", input: { action: "spawn" } },
			],
		},
		{
			segments: [{ kind: "text", text: "Two reviews are running in parallel; I’ll merge their findings before changing the refresh path." }],
		},
		{
			segments: [{ kind: "text", text: "I’ll tighten the compact tool spacing and verify narrow-terminal behavior." }],
		},
		{
			segments: [{ kind: "text", text: "I’ll compare the release checks across Linux, macOS, and Windows before publishing." }],
		},
	], {
		openaiProviderId: "openai-codex",
		modelId: "gpt-5.4",
	});

	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(join(agentDir, "extensions"), { recursive: true });
		await mkdir(join(workspace, "src", "auth"), { recursive: true });
		await mkdir(join(workspace, ".pi"), { recursive: true });
		await symlink(join(projectRoot, "node_modules"), join(tempDir, "node_modules"), "dir");
		await writeFile(join(agentDir, "models.json"), JSON.stringify(mockModel.modelsJson(), null, 2));
		await writeFile(join(agentDir, "extensions", "readme-screenshot-fixtures.ts"), fixtureExtension);
		await writeFile(join(workspace, ".pi", "pix.jsonc"), JSON.stringify({
			toolRenderer: {
				tools: {
					subagents: { previewLines: 1, direction: "head", color: "muted" },
				},
			},
		}, null, 2));
		await writeFile(join(workspace, "src", "auth", "session.ts"), [
			"export async function loadSession(token: string) {",
			"  const session = await store.findByToken(token);",
			"  if (!session || session.expiresAt <= Date.now()) return undefined;",
			"  return session;",
			"}",
			"",
		].join("\n"));
		await mkdir(outputDir, { recursive: true });

		const pixCommand = [
			"exec env -u NO_COLOR",
			`HOME=${shellQuote(tempDir)}`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`PATH=${shellQuote(`${join(projectRoot, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`)}`,
			"PI_TERMINAL_BELL_DISABLED=1",
			"PI_SESSION_TITLE_ENABLED=0",
			"PI_SESSION_TITLE_TERMINAL_TITLE=0",
			"PI_TOOLS_SUITE_DISABLED=1",
			shellQuote(process.execPath),
			"--import tsx",
			shellQuote(join(projectRoot, "src", "main.ts")),
			"--cwd", shellQuote(workspace),
			"--model", shellQuote(mockModel.openaiModelRef),
		].join(" ");

		await tmux("new-session", "-d", "-s", sessionName, "-x", String(cols), "-y", String(rows), "-c", projectRoot, pixCommand);
		await waitFor(mockModel.openaiModelRef);
		await send("Auth hardening: find the safest place to fix expired sessions without widening the change.");
		await tmux("send-keys", "-t", sessionName, "Enter");
		await waitFor("expiry regression test");
		await new Promise((resolveWait) => setTimeout(resolveWait, 500));
		await writeScreenshot("pix-overview", await capture(true), "Pix · agent workspace");

		await send("/");
		await new Promise((resolveWait) => setTimeout(resolveWait, 900));
		await writeScreenshot("pix-command-menu", await capture(true), "Pix · commands and workflows");
		await sendEscape();
		await tmux("send-keys", "-t", sessionName, "BSpace");

		await send("Turn this into an adaptive implementation plan with explicit dependencies.");
		await tmux("send-keys", "-t", sessionName, "Enter");
		await waitFor("implementation order is now explicit");
		await new Promise((resolveWait) => setTimeout(resolveWait, 500));
		await writeScreenshot("pix-adaptive-todo", await capture(true), "Pix · adaptive implementation plan");

		await send("Run the independent review tracks in parallel while I keep the main implementation path.");
		await tmux("send-keys", "-t", sessionName, "Enter");
		await waitFor("merge their findings");
		await new Promise((resolveWait) => setTimeout(resolveWait, 500));
		await writeScreenshot("pix-subagents", await capture(true), "Pix · parallel sub-agents");

		await clickNewTab();
		await send("Renderer polish: audit compact tool spacing on narrow terminals.");
		await tmux("send-keys", "-t", sessionName, "Enter");
		await waitFor("narrow-terminal behavior");
		await clickNewTab();
		await send("Release checks: compare CI across Linux, macOS, and Windows before publishing.");
		await tmux("send-keys", "-t", sessionName, "Enter");
		await waitFor("before publishing");
		await new Promise((resolveWait) => setTimeout(resolveWait, 500));
		const tabsCapture = (await capture(true)).split(workspace).join("~/projects/pix");
		await writeScreenshot("pix-tabs", tabsCapture, "Pix · project-scoped session tabs");

		console.log(`Wrote README screenshots to ${outputDir}`);
	} finally {
		await tmux("kill-server").catch(() => undefined);
		await mockModel.stop();
		await rm(tempDir, { recursive: true, force: true });
	}
}

await main();
