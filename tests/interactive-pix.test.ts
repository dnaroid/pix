import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { once } from "node:events";

import { MockModel, waitFor } from "./helpers/mock-model.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const PIX_MAIN = join(PROJECT_ROOT, "src", "main.ts");
const PTY_DRIVER = join(PROJECT_ROOT, "tests", "helpers", "pty-driver.py");
const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 100;

/**
 * PTY tests run on Linux in CI. Set PIX_TEST_PTY=1 to force-run them locally on
 * macOS too (the pty-driver is pure POSIX and works there, but macOS PTY teardown
 * is flaky enough that CI keeps it gated to Linux). Windows is hard-skipped: the
 * driver needs termios/openpty, which Windows does not provide.
 */
const PTY_SKIP_REASON = resolvePtySkipReason();

describe("pix interactive PTY", { skip: PTY_SKIP_REASON }, () => {
	it("handles mouse click and drag-selection in the real terminal UI", async () => {
		const mockModel = await MockModel.start(["short mocked reply"]);
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			const statusRow = pix.rows;
			const statusLine = pix.screen.line(statusRow);
			const modelColumn = statusLine.indexOf(mockModel.openaiModelRef) + 1;
			assert.ok(modelColumn > 0, statusLine);
			const selectionEnd = modelColumn + mockModel.openaiModelRef.length;

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
		const mockModel = await MockModel.start([response]);
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

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

	it("streams a tool call and renders the read tool block through the full stack", async () => {
		const mockModel = await MockModel.start([{
			segments: [
				{ kind: "thinking", text: "Let me read the probe file." },
				{ kind: "text", text: "Opening PIX-PROBE.txt now." },
				{ kind: "tool_use", name: "read", input: { file_path: "PIX-PROBE.txt" } },
			],
		}, "PIX-TOOL-FOLLOWUP"]);
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("please read the probe file");
			pix.enter();

			await pix.waitForText("PIX-PROBE.txt", "read tool header with relative path");
			await pix.waitForText("PIX-TOOL-FOLLOWUP", "assistant follow-up after tool result round-trip");
			assert.ok(mockModel.requestCount >= 2, "tool result produced a follow-up request");
			assert.equal(mockModel.requests[0]?.api, "openai-completions");
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("keeps later tool calls visible after a large expanded apply_patch block", async () => {
		const patchBody = Array.from({ length: 90 }, (_value, index) => `+PIX-E2E-PATCH-LINE-${String(index).padStart(2, "0")}`).join("\n");
		const patch = [
			"*** Begin Patch",
			"*** Add File: pix-e2e-large-patch.txt",
			patchBody,
			"*** End Patch",
		].join("\n");
		const mockModel = await MockModel.start([
			{ segments: [{ kind: "tool_use", name: "apply_patch", input: { input: patch } }] },
			{ segments: [{ kind: "tool_use", name: "shell", input: { command: "printf PIX-E2E-SHELL-DONE" } }] },
		], { defaultResponse: "PIX-E2E-FINAL" });
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("apply a large patch, then run the shell marker");
			pix.enter();

			await pix.waitForText("apply_patch", "large apply_patch tool header");
			await pix.waitForText("PIX-E2E-SHELL-DONE", "shell result remains visible after the expanded patch", 15_000);
			await pix.waitForText("PIX-E2E-FINAL", "final assistant response after shell", 15_000);
			assert.ok(mockModel.requestCount >= 3, `expected patch, shell follow-up, and final requests; got ${mockModel.requestCount}`);
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("streams reasoning and text through the anthropic-messages provider", async () => {
		const mockModel = await MockModel.start([{
			segments: [
				{ kind: "thinking", text: "Reasoning about the answer.", signature: "sig-pix-test" },
				{ kind: "text", text: "PIX-ANTHROPIC-TEXT" },
			],
		}]);
		const pix = await PixPty.start(mockModel, { modelRef: mockModel.anthropicModelRef });

		try {
			await pix.waitForText(mockModel.anthropicModelRef, "anthropic provider status line");

			pix.write("answer via anthropic");
			pix.enter();

			await pix.waitForText("PIX-ANTHROPIC-TEXT", "anthropic streamed text");
			assert.equal(mockModel.requestCount, 1);
			assert.equal(mockModel.requests[0]?.api, "anthropic-messages");
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("survives a mid-stream abort and recovers on the next turn", async () => {
		// Queue only the aborted turn; the recovery marker is served for every
		// subsequent request (SDK retry of the aborted turn, or our explicit
		// second prompt), so the assertion stays deterministic regardless of how
		// many retries the SDK performs.
		const mockModel = await MockModel.start(
			[{ segments: [{ kind: "text", text: "PIX-ABORT-PARTIAL" }], error: { midStream: true } }],
			{ defaultResponse: "PIX-ABORT-RECOVERED" },
		);
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("trigger an aborted stream");
			pix.enter();
			await pix.waitForText("PIX-ABORT-PARTIAL", "partial content rendered before abort");

			// The aborted turn surfaces an error and returns control to the input.
			await sleep(500);
			pix.write("try again");
			pix.enter();
			await pix.waitForText("PIX-ABORT-RECOVERED", "recovered response after the failed turn");
			assert.ok(mockModel.requestCount >= 2, `expected at least 2 requests, got ${mockModel.requestCount}`);
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("surfaces a rate-limit (429) error and recovers on the next turn", async () => {
		// The first request returns HTTP 429 before any SSE. pi-ai surfaces the
		// rate-limit error to the TUI; the turn must end without hanging and a
		// subsequent prompt must succeed.
		const mockModel = await MockModel.start(
			[{ segments: [{ kind: "text", text: "never streamed" }], error: { status: 429, message: "rate limited" } }],
			{ defaultResponse: "PIX-429-RECOVERED" },
		);
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("trigger a rate limit");
			pix.enter();
			// Give the failed turn time to surface its error and return control.
			await sleep(1000);

			pix.write("try again after rate limit");
			pix.enter();
			await pix.waitForText("PIX-429-RECOVERED", "recovered response after rate-limit error");
			assert.ok(mockModel.requestCount >= 1, `expected at least 1 request, got ${mockModel.requestCount}`);
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("does not crash when the model streams malformed tool-call JSON arguments", async () => {
		// pi-ai's parseStreamingJson always returns an object (cascading through
		// JSON.parse -> repair -> partial-json -> {}), so malformed/truncated tool
		// args must never crash the renderer or the agent loop. We assert the
		// assistant text before the call renders, the tool block header still
		// appears, and a follow-up turn is reachable.
		const mockModel = await MockModel.start(
			[{
				segments: [
					{ kind: "text", text: "PIX-MALFORMED-PREFIX calling a tool" },
					// Deliberately malformed JSON: unquoted key, truncated value.
					{ kind: "tool_use", name: "pix_probe_tool", input: "{ file_path: " },
				],
			}],
			{ defaultResponse: "PIX-MALFORMED-FOLLOWUP" },
		);
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("emit malformed tool args");
			pix.enter();
			await pix.waitForText("PIX-MALFORMED-PREFIX", "assistant text before the malformed call");
			// The tool-call header renders verbatim for an unknown tool name, even
			// though its JSON args could not be parsed into a real path.
			await pix.waitForText("pix_probe_tool", "tool-call header renders despite malformed args");

			pix.write("continue after malformed tool args");
			pix.enter();
			await pix.waitForText("PIX-MALFORMED-FOLLOWUP", "turn continued after malformed tool args");
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("runs a multi-turn conversation against a queued set of responses", async () => {
		const mockModel = await MockModel.start(["PIX-TURN-ONE", "PIX-TURN-TWO"]);
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("first turn");
			pix.enter();
			await pix.waitForText("PIX-TURN-ONE", "first turn response");

			pix.write("second turn");
			pix.enter();
			await pix.waitForText("PIX-TURN-TWO", "second turn response");
			assert.equal(mockModel.requestCount, 2);
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("aborts a streaming turn with Ctrl+C and returns control to the input", async () => {
		// A long streamed response; the abort must surface through the real abort
		// state machine in input-action-controller.ts (abortInFlight, "aborting"
		// status) and hand control back so the next prompt works.
		const longResponse = Array.from({ length: 120 }, (_, index) => `PIX-ABORT-CTRL-LINE-${index}`).join("\n");
		const mockModel = await MockModel.start([longResponse], { chunkDelayMs: 20, defaultResponse: "PIX-ABORT-CTRL-RECOVERED" });
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("produce a long response");
			pix.enter();
			await pix.waitForText("PIX-ABORT-CTRL-LINE-1", "streaming started before abort");

			pix.write("\x03");
			// Give the abort a moment to propagate: the stream must stop before its
			// final line arrives. With chunkDelayMs the full 120-line response takes
			// ~2.4s, but we abort near the start, so the last line must never appear.
			await sleep(700);
			assert.ok(
				!pix.screen.includes("PIX-ABORT-CTRL-LINE-119"),
				`abort did not stop the stream (last line appeared)\n\n${pix.screen.snapshot()}`,
			);

			pix.write("after abort");
			pix.enter();
			await pix.waitForText("PIX-ABORT-CTRL-RECOVERED", "turn runs after Ctrl+C abort");
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("renders two tool calls streamed back-to-back in one assistant turn", async () => {
		// Two consecutive tool_use segments must both render and both complete
		// their round-trip. Only a single tool_use is covered elsewhere.
		const mockModel = await MockModel.start([{
			segments: [
				{ kind: "tool_use", name: "read", input: { file_path: "PIX-PARALLEL-A.txt" } },
				{ kind: "tool_use", name: "read", input: { file_path: "PIX-PARALLEL-B.txt" } },
			],
		}], { defaultResponse: "PIX-PARALLEL-FOLLOWUP" });
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("read both probe files");
			pix.enter();
			await pix.waitForText("PIX-PARALLEL-A.txt", "first parallel tool header");
			await pix.waitForText("PIX-PARALLEL-B.txt", "second parallel tool header");
			await pix.waitForText("PIX-PARALLEL-FOLLOWUP", "follow-up after both tool round-trips");
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("keeps rendering correctly after a terminal resize mid-stream", async () => {
		// Resize the PTY while content is streaming; the foreground app gets
		// SIGWINCH, re-reads columns/rows, and must keep rendering without breaking
		// the layout. A unit test with a fake session cannot exercise this path.
		const response = Array.from({ length: 80 }, (_, index) => `PIX-RESIZE-LINE-${index}`).join("\n");
		// chunkDelayMs keeps the stream in flight long enough to observe its start
		// and resize while content is still flowing (real streaming has inter-token
		// latency; without a delay the whole response flushes instantly and the
		// first lines scroll off before the first poll).
		const mockModel = await MockModel.start([response], { chunkSize: 12, chunkDelayMs: 20 });
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("produce many lines then we resize");
			pix.enter();
			await pix.waitForText("PIX-RESIZE-LINE-0", "streaming started before resize");

			pix.resize(30, 60);
			await sleep(500);
			pix.resize(DEFAULT_ROWS, DEFAULT_COLS);

			await pix.waitForText("PIX-RESIZE-LINE-79", "full content rendered after resize round-trip");
			const snapshot = pix.screen.snapshot();
			// No leftover NUL bytes from the resize sentinel leaking into the screen.
			assert.ok(!snapshot.includes("\x00"), "resize sentinel bytes leaked into the screen");
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("queues a steering message submitted while the assistant is streaming", async () => {
		// While isStreaming is true, the queued-message-controller submits the
		// message with streamingBehavior 'steer' instead of waiting. The SDK queues
		// it and the UI renders a queued entry whose text appears on screen. A fake
		// session cannot exercise this because it never reports isStreaming.
		const longResponse = Array.from({ length: 60 }, (_, index) => `PIX-STEER-LINE-${index}`).join("\n");
		const mockModel = await MockModel.start([longResponse], { chunkSize: 12, chunkDelayMs: 20 });
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("produce a long response");
			pix.enter();
			await pix.waitForText("PIX-STEER-LINE-0", "streaming started before steering");

			pix.write("PIX-STEER-MARKER steer me");
			pix.enter();
			// The queued steering entry must render on screen while the original
			// stream is still in flight.
			await pix.waitForText("PIX-STEER-MARKER", "queued steering entry visible during stream");
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("keeps older content visible when scrolling up while the assistant is streaming", async () => {
		// Detaching from the bottom during a stream (wheelUp) must show older lines
		// rather than forcing stick-to-bottom. Covers scroll-controller.ts detached
		// scroll path that unit tests with a fake session cannot reach.
		const response = Array.from({ length: 60 }, (_, index) => `PIX-SCROLL-LINE-${index}`).join("\n");
		// First lines carry a distinct early marker for a deterministic assertion.
		const earlyResponse = response.replace("PIX-SCROLL-LINE-0", "PIX-SCROLL-EARLY");
		const mockModel = await MockModel.start([earlyResponse], { chunkSize: 12, chunkDelayMs: 20 });
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("produce many lines");
			pix.enter();
			await pix.waitForText("PIX-SCROLL-EARLY", "first lines rendered before scroll");

			// Detach from the bottom while content is still streaming.
			for (let index = 0; index < 12; index += 1) pix.wheelUp(10, 6);
			await sleep(300);
			// The early line must remain on screen after detaching upward.
			assert.ok(
				pix.screen.includes("PIX-SCROLL-EARLY"),
				`early content lost after wheel up during stream\n\n${pix.screen.snapshot()}`,
			);
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("inserts a bracketed multi-line paste into the input without submitting it", async () => {
		// Bracketed paste wraps pasted bytes in \x1b[200~ ... \x1b[201~. The app
		// must place the text in the editor as a virtual `[Pasted ~N lines]` tag and
		// must NOT submit it as a prompt, even though it contains newlines. We also
		// confirm the full text survives the round-trip by submitting it afterwards
		// and inspecting the request body. Covers input-paste-handler.ts +
		// input-editor.ts attachPastedText, invisible to fake-session unit tests.
		const mockModel = await MockModel.start(["PIX-PASTE-RESPONSE"]);
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("\x1b[200~PIX-PASTE-LINE-ONE\nPIX-PASTE-LINE-TWO\x1b[201~");
			await pix.waitForText(/\[Pasted ~2 lines\]/u, "multi-line paste collapsed into a virtual tag");
			// Crucially, the paste must not have submitted a prompt.
			assert.equal(
				mockModel.requestCount,
				0,
				`paste submitted a prompt: requestCount=${mockModel.requestCount}\n\n${pix.screen.snapshot()}`,
			);

			// The full multi-line content must survive the virtual-tag round-trip.
			pix.enter();
			await pix.waitForText("PIX-PASTE-RESPONSE", "pasted prompt submitted after explicit enter");
			const lastRequest = mockModel.requests[mockModel.requests.length - 1]?.body as
				| { messages?: Array<{ role?: string; content?: unknown }> }
				| undefined;
			const serialized = lastRequest?.messages ? JSON.stringify(lastRequest.messages) : "";
			assert.ok(
				serialized.includes("PIX-PASTE-LINE-ONE") && serialized.includes("PIX-PASTE-LINE-TWO"),
				"pasted multi-line text was not preserved in the submitted request body",
			);
		} finally {
			await pix.stop();
			await mockModel.stop();
		}
	});

	it("renders CJK characters and emoji in a streamed response without crashing", async () => {
		// terminal-width.ts assigns width 2 to full-width CJK and emoji graphemes.
		// A real terminal must lay these out without breaking the column math. The
		// render path (column width + cursor advance) is invisible to unit tests
		// that stub the screen.
		const mockModel = await MockModel.start(["PIX-CJK 日本語 emoji 🚀 DONE"], { chunkSize: 8 });
		const pix = await PixPty.start(mockModel);

		try {
			await pix.waitForText(mockModel.openaiModelRef, "initial status line");

			pix.write("send unicode");
			pix.enter();
			await pix.waitForText("PIX-CJK", "streaming started before unicode payload");
			await pix.waitForText("DONE", "stream completed after unicode payload");
			assert.ok(pix.screen.includes("日本語"), `CJK text missing\n\n${pix.screen.snapshot()}`);
			assert.ok(pix.screen.includes("🚀"), `emoji missing\n\n${pix.screen.snapshot()}`);
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
	rows: number;
	cols: number;
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

	static async start(mockModel: MockModel, options: { rows?: number; cols?: number; modelRef?: string } = {}): Promise<PixPty> {
		const rows = options.rows ?? DEFAULT_ROWS;
		const cols = options.cols ?? DEFAULT_COLS;
		const modelRef = options.modelRef ?? mockModel.openaiModelRef;
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
			modelRef,
		], {
			cwd: PROJECT_ROOT,
			env: {
				...process.env,
				HOME: tempDir,
				PI_CODING_AGENT_DIR: agentDir,
				PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ""}`,
				PIX_TEST_CLIPBOARD_CAPTURE: clipboardCapturePath,
				// Disable the bundled terminal-bell extension so it never writes \x07
				// or spawns terminal-notifier/osascript during tests.
				PI_TERMINAL_BELL_DISABLED: "1",
				// Disable the bundled session-title extension so it never makes LLM
				// title-generation requests against the mock (which would inflate
				// requestCount and race with the assertions).
				PI_SESSION_TITLE_ENABLED: "0",
				// Keep the terminal title from being rewritten to a session name.
				PI_SESSION_TITLE_TERMINAL_TITLE: "0",
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

	/**
	 * Resize the PTY mid-run via the sideband sentinel the pty-driver intercepts.
	 * The driver calls TIOCSWINSZ on the master fd and signals SIGWINCH to the
	 * child, which is how a real terminal tells a foreground app the window grew
	 * or shrank. Updates the local screen model so snapshot()/line() match the new
	 * geometry after the app re-renders.
	 */
	resize(rows: number, cols: number): void {
		this.rows = rows;
		this.cols = cols;
		this.screen.resize(rows, cols);
		this.write(`\x00PIXWINSZ:${rows}:${cols}\x00`);
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
	private rows: number;
	private cols: number;

	constructor(rows: number, cols: number) {
		this.rows = rows;
		this.cols = cols;
		this.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
	}

	/**
	 * Grow/shrink the model to the new geometry. Existing cells outside the new
	 * bounds are dropped; missing rows/columns are padded blank, mirroring what a
	 * real terminal shows after the foreground app re-renders to the new size.
	 */
	resize(rows: number, cols: number): void {
		const resized = Array.from({ length: rows }, (_, rowIndex) => {
			const existing = this.cells[rowIndex];
			if (!existing) return Array.from({ length: cols }, () => " ");
			if (existing.length === cols) return existing;
			return existing.length > cols
				? existing.slice(0, cols)
				: [...existing, ...Array.from({ length: cols - existing.length }, () => " ")];
		});
		this.cells.length = 0;
		this.cells.push(...resized);
		this.rows = rows;
		this.cols = cols;
		this.row = Math.min(this.row, rows);
		this.col = Math.min(this.col, cols);
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function hasPython3(): boolean {
	return spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * Decide whether the PTY suite should skip. Returns a human-readable reason, or
 * `false` to run. Priority:
 *   1. Windows is always skipped (no termios/openpty in the pty driver).
 *   2. python3 is required.
 *   3. PIX_TEST_PTY=1 opts in on any non-Windows platform (local macOS runs).
 *   4. Otherwise Linux runs (CI); every other POSIX platform is skipped.
 */
function resolvePtySkipReason(): string | false {
	if (process.platform === "win32") return "PTY driver requires termios (not available on Windows)";
	if (!hasPython3()) return "python3 not found on PATH (required to run the PTY driver)";
	if (process.env.PIX_TEST_PTY === "1") return false;
	if (process.platform === "linux") return false;
	return `PTY tests are Linux-only in CI; set PIX_TEST_PTY=1 to run locally on ${process.platform}`;
}
