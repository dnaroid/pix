import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const PIX_MAIN = join(PROJECT_ROOT, "src", "main.ts");
const PTY_DRIVER = join(PROJECT_ROOT, "tests", "helpers", "pty-driver.py");
const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 100;

describe("pix interactive PTY", { skip: process.platform !== "linux" || !hasPython3() }, () => {
	it("handles mouse click and drag-selection in the real terminal UI", async () => {
		const mockModel = await MockOpenAIModel.start(["short mocked reply"]);
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText("pix-test/mock", "initial status line");

			const statusRow = pix.rows;
			const statusLine = pix.screen.line(statusRow);
			const modelColumn = statusLine.indexOf("pix-test/mock") + 1;
			assert.ok(modelColumn > 0, statusLine);
			const selectionEnd = modelColumn + "pix-test/mock".length;

			pix.drag(modelColumn, statusRow, selectionEnd, statusRow);
			await pix.waitForText(/Copied to clipboard|Copy failed/u, "selection copy toast");

			pix.click(modelColumn, statusRow);
			await pix.waitForText("Select model", "model popup after status click");
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("submits a prompt to a mocked model and scrolls with mouse wheel events", async () => {
		const response = Array.from({ length: 56 }, (_, index) => `PIX-LINE-${String(index + 1).padStart(2, "0")}`).join("\n");
		const mockModel = await MockOpenAIModel.start([response]);
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText("pix-test/mock", "initial status line");

			pix.write("please produce many lines");
			pix.enter();
			await pix.waitForText("PIX-LINE-56", "mocked model response");
			assert.equal(mockModel.requestCount, 1);

			for (let index = 0; index < 8; index += 1) pix.wheelUp(10, 6);
			await pix.waitForText(/PIX-LINE-(1[0-9]|2[0-9]|3[0-9])/u, "older content after wheel up");

			for (let index = 0; index < 8; index += 1) pix.wheelDown(10, 6);
			await pix.waitForText("PIX-LINE-56", "latest content after wheel down");
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});
});

after(async () => {
	// Keep any failed run from leaking a temporary transcript/process tree for later tests.
	await Promise.all(activePixProcesses.splice(0).map((pix) => pix.stop()));
});

const activePixProcesses: PixPty[] = [];

class PixPty {
	readonly screen: TerminalScreen;
	readonly rows: number;
	readonly cols: number;
	private stopped = false;

	private constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly tempDir: string,
		options: { rows: number; cols: number },
	) {
		this.rows = options.rows;
		this.cols = options.cols;
		this.screen = new TerminalScreen(options.rows, options.cols);
		this.child.stdout.on("data", (chunk: Buffer) => {
			this.screen.write(chunk.toString("utf8"));
		});
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.screen.write(chunk.toString("utf8"));
		});
	}

	static async start(mockModel: MockOpenAIModel, options: { rows?: number; cols?: number } = {}): Promise<PixPty> {
		const rows = options.rows ?? DEFAULT_ROWS;
		const cols = options.cols ?? DEFAULT_COLS;
		const tempDir = mkdtempSync(join(tmpdir(), "pix-pty-"));
		const agentDir = join(tempDir, "agent");
		const workspace = join(tempDir, "workspace");
		const fakeBinDir = join(tempDir, "bin");
		const clipboardCapturePath = join(tempDir, "clipboard.txt");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(workspace, { recursive: true });
		installFakeClipboardCommands(fakeBinDir);
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(mockModel.modelsJson(), null, 2));

		const child = spawn("python3", [
			PTY_DRIVER,
			String(rows),
			String(cols),
			process.execPath,
			"--import",
			"tsx",
			PIX_MAIN,
			"--cwd",
			workspace,
			"--no-session",
			"--model",
			"pix-test/mock",
		], {
			cwd: PROJECT_ROOT,
			env: {
				...process.env,
				HOME: tempDir,
				PI_CODING_AGENT_DIR: agentDir,
				PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ""}`,
				PIX_TEST_CLIPBOARD_CAPTURE: clipboardCapturePath,
				TERM: "xterm-256color",
				NO_COLOR: undefined,
			},
		});

		const pix = new PixPty(child, tempDir, { rows, cols });
		activePixProcesses.push(pix);
		child.once("exit", () => {
			const index = activePixProcesses.indexOf(pix);
			if (index >= 0) activePixProcesses.splice(index, 1);
		});
		return pix;
	}

	write(text: string): void {
		this.child.stdin.write(text);
	}

	enter(): void {
		this.write("\x1b[13u");
	}

	click(x: number, y: number): void {
		this.mouse(0, x, y, "M");
		this.mouse(0, x, y, "m");
	}

	drag(startX: number, startY: number, endX: number, endY: number): void {
		this.mouse(0, startX, startY, "M");
		this.mouse(32, endX, endY, "M");
		this.mouse(0, endX, endY, "m");
	}

	wheelUp(x: number, y: number): void {
		this.mouse(64, x, y, "M");
	}

	wheelDown(x: number, y: number): void {
		this.mouse(65, x, y, "M");
	}

	async waitForText(text: string | RegExp, label: string, timeoutMs = 10_000): Promise<void> {
		await waitFor(() => this.screen.includes(text), () => `${label}\n\n${this.screen.snapshot()}`, timeoutMs);
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.write("\x03");
		await Promise.race([
			once(this.child, "exit"),
			new Promise<void>((resolveStop) => setTimeout(resolveStop, 1_000)),
		]);
		if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
		await Promise.race([
			once(this.child, "exit"),
			new Promise<void>((resolveStop) => setTimeout(resolveStop, 1_000)),
		]);
		if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
		await Promise.race([
			once(this.child, "exit"),
			new Promise<void>((resolveStop) => setTimeout(resolveStop, 1_000)),
		]);
		rmSync(this.tempDir, { recursive: true, force: true });
	}

	private mouse(button: number, x: number, y: number, suffix: "M" | "m"): void {
		this.write(`\x1b[<${button};${x};${y}${suffix}`);
	}
}

function installFakeClipboardCommands(binDir: string): void {
	mkdirSync(binDir, { recursive: true });
	const script = "#!/bin/sh\ncat > \"$PIX_TEST_CLIPBOARD_CAPTURE\"\n";
	for (const command of ["pbcopy", "wl-copy", "xclip", "xsel", "clip.exe"]) {
		const commandPath = join(binDir, command);
		writeFileSync(commandPath, script);
		chmodSync(commandPath, 0o755);
	}
}

class TerminalScreen {
	private readonly cells: string[][];
	private row = 1;
	private col = 1;

	constructor(private readonly rows: number, private readonly cols: number) {
		this.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
	}

	write(data: string): void {
		for (let index = 0; index < data.length;) {
			const char = data[index] ?? "";
			if (char === "\x1b") {
				index = this.consumeEscape(data, index);
				continue;
			}
			if (char === "\r") {
				this.col = 1;
				index += 1;
				continue;
			}
			if (char === "\n") {
				this.row = Math.min(this.rows, this.row + 1);
				index += 1;
				continue;
			}
			if (char >= " " && char !== "\x7f") this.put(char);
			index += 1;
		}
	}

	line(row: number): string {
		return (this.cells[row - 1] ?? []).join("").trimEnd();
	}

	includes(text: string | RegExp): boolean {
		const snapshot = this.snapshot();
		return typeof text === "string" ? snapshot.includes(text) : text.test(snapshot);
	}

	findRow(pattern: RegExp): number | undefined {
		for (let row = 1; row <= this.rows; row += 1) {
			if (pattern.test(this.line(row))) return row;
		}
		return undefined;
	}

	snapshot(): string {
		return Array.from({ length: this.rows }, (_, index) => this.line(index + 1)).join("\n");
	}

	private consumeEscape(data: string, start: number): number {
		const next = data[start + 1];
		if (next !== "[") return Math.min(data.length, start + 2);

		let end = start + 2;
		while (end < data.length && !/[A-Za-z~]/u.test(data[end] ?? "")) end += 1;
		if (end >= data.length) return data.length;

		const command = data[end] ?? "";
		const params = data.slice(start + 2, end);
		this.applyCsi(command, params);
		return end + 1;
	}

	private applyCsi(command: string, params: string): void {
		if (command === "H" || command === "f") {
			const [row = "1", col = "1"] = params.split(";");
			this.row = clamp(Number(row) || 1, 1, this.rows);
			this.col = clamp(Number(col) || 1, 1, this.cols);
			return;
		}
		if (command === "K" && (params === "2" || params === "")) {
			this.cells[this.row - 1]?.fill(" ");
			this.col = 1;
			return;
		}
		if (command === "J" && (params === "2" || params === "")) {
			for (const line of this.cells) line.fill(" ");
			this.row = 1;
			this.col = 1;
		}
	}

	private put(char: string): void {
		if (this.row >= 1 && this.row <= this.rows && this.col >= 1 && this.col <= this.cols) {
			const line = this.cells[this.row - 1];
			if (line) line[this.col - 1] = char;
		}
		this.col = Math.min(this.cols, this.col + 1);
	}
}

class MockOpenAIModel {
	requestCount = 0;
	private readonly server: Server;

	private constructor(private readonly responses: string[]) {
		this.server = createServer((request, response) => {
			void this.handleRequest(request, response);
		});
	}

	static async start(responses: string[]): Promise<MockOpenAIModel> {
		const mock = new MockOpenAIModel(responses);
		mock.server.listen(0, "127.0.0.1");
		await once(mock.server, "listening");
		return mock;
	}

	modelsJson(): unknown {
		return {
			providers: {
				"pix-test": {
					name: "Pix PTY Test",
					baseUrl: `${this.baseUrl()}/v1`,
					api: "openai-completions",
					apiKey: "test-key",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: [{
						id: "mock",
						name: "Mock Model",
						reasoning: false,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 8192,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					}],
				},
			},
		};
	}

	async stop(): Promise<void> {
		this.server.closeAllConnections();
		await new Promise<void>((resolveStop) => this.server.close(() => resolveStop()));
	}

	private baseUrl(): string {
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Mock server is not listening");
		return `http://127.0.0.1:${address.port}`;
	}

	private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}

		this.requestCount += 1;
		for await (const _ of request) {
			// Drain the SDK request body; assertions only need to know the mocked model was called.
		}

		const text = this.responses.shift() ?? "default mocked response";
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		this.writeChunk(response, { role: "assistant" });
		for (const chunk of splitResponse(text)) this.writeChunk(response, { content: chunk });
		response.write(`data: ${JSON.stringify({
			id: "chatcmpl-pix-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "mock",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\n`);
		response.write("data: [DONE]\n\n");
		response.end();
	}

	private writeChunk(response: ServerResponse, delta: Record<string, unknown>): void {
		response.write(`data: ${JSON.stringify({
			id: "chatcmpl-pix-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "mock",
			choices: [{ index: 0, delta, finish_reason: null }],
		})}\n\n`);
	}
}

function splitResponse(text: string): string[] {
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += 32) chunks.push(text.slice(index, index + 32));
	return chunks;
}

async function waitFor(predicate: () => boolean, message: () => string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
	assert.fail(message());
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function hasPython3(): boolean {
	return spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
}
