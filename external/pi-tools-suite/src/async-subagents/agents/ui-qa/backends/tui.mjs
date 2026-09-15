import fs from "node:fs";
import path from "node:path";
import pty from "@lydell/node-pty";
import xterm from "@xterm/headless";
import { NATIVE_TERMINAL_PRESENTATION, probeNativeTerminalBackend, startNativeTerminalDisplay } from "../drivers/native-terminal/native-terminal-host.mjs";

const { Terminal } = xterm;
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const RECORDING_FILE = "terminal-recording.cast";
const MAX_ARG_LENGTH = 4096;
const CLEANUP_GRACE_MS = 1_000;
const PTY_PRESENTATION = "pty";
const SAFE_ENV = new Set(["CI", "NO_COLOR", "FORCE_COLOR", "LANG", "LC_ALL", "TERM", "TZ"]);
const BLOCKED_EXECUTABLES = new Set([
	"sh", "bash", "zsh", "fish", "dash", "ksh", "cmd", "cmd.exe", "powershell", "powershell.exe",
	"pwsh", "pwsh.exe", "osascript", "wscript", "wscript.exe", "cscript", "cscript.exe",
]);
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print", "-command", "--command", "/c"]);
const STEP_FIELDS = {
	waitForStable: new Set(["action", "settleMs", "timeoutMs"]),
	waitForText: new Set(["action", "text", "settleMs", "timeoutMs"]),
	sendText: new Set(["action", "text", "timeoutMs"]),
	sendKeys: new Set(["action", "keys", "timeoutMs"]),
	resize: new Set(["action", "cols", "rows", "settleMs", "timeoutMs"]),
	assertText: new Set(["action", "text", "timeoutMs"]),
	assertNotText: new Set(["action", "text", "timeoutMs"]),
	assertCursor: new Set(["action", "row", "column", "timeoutMs"]),
	assertProcessRunning: new Set(["action", "timeoutMs"]),
	assertProcessExited: new Set(["action", "exitCode", "timeoutMs"]),
	capture: new Set(["action", "name", "timeoutMs"]),
};

const KEY_SEQUENCES = {
	enter: "\r",
	tab: "\t",
	escape: "\u001b",
	backspace: "\u007f",
	delete: "\u001b[3~",
	space: " ",
	up: "\u001b[A",
	down: "\u001b[B",
	right: "\u001b[C",
	left: "\u001b[D",
	home: "\u001b[H",
	end: "\u001b[F",
	pageup: "\u001b[5~",
	pagedown: "\u001b[6~",
};

const NATIVE_TERMINAL_ACTIONS = new Set([
	"waitForStable", "waitForText", "sendText", "sendKeys", "assertText", "assertNotText", "assertCursor",
	"assertProcessRunning", "assertProcessExited", "capture",
]);

export async function probeTuiBackend(context = {}) {
	const presentation = resolveTuiPresentation(context.flow);
	if (presentation === NATIVE_TERMINAL_PRESENTATION) {
		return { ...(await probeNativeTerminalBackend(context)), guideTopic: "native-terminal" };
	}
	return {
		available: true,
		guideTopic: "pty",
		platformDriver: process.platform === "win32" ? "conpty+xterm" : "forkpty+xterm",
		supportedCapabilities: [
			"launch", "ptyInput", "terminalResize", "screenState", "ansiVt", "alternateScreen",
			"stableFrame", "visibleTextAssertions", "cursorAssertions", "terminalCapture", "terminalRecording", "ownedCleanup",
		],
		missingCapabilities: ["terminalScreenshot"],
		reason: "the bundled PTY and headless terminal emulator are available",
	};
}

export async function runTuiBackend(context) {
	const config = validateFlow(context.flow, context.projectRoot);
	const nativePresentation = config.presentation === NATIVE_TERMINAL_PRESENTATION;
	const assertions = [];
	const observations = [];
	const artifacts = emptyArtifacts();
	if (nativePresentation) {
		const probe = await probeNativeTerminalBackend(context);
		if (!probe.available) {
			return { status: "BLOCKED", reason: probe.reason, remediation: probe.remediation, assertions, observations, artifacts };
		}
	}
	let nativeDisplay;
	let recording;
	let terminal;
	let processHandle;
	let failure;
	let nativeDisplayFailure;
	let transcript = Buffer.alloc(0);
	let transcriptTruncated = false;
	let writeChain = Promise.resolve();
	let exited = false;
	let exitInfo;
	let lastDataAt = Date.now();
	let lastFrameChangeAt = Date.now();
	let lastFingerprint = "";
	let resolveExit;
	const exitPromise = new Promise((resolve) => { resolveExit = resolve; });

	try {
		if (nativePresentation) nativeDisplay = await startNativeTerminalDisplay(context, observations, artifacts);
		const viewport = nativeDisplay?.viewport ?? config.viewport;
		// The asciicast always mirrors the PTY stream for diagnosis. In native-
		// terminal mode it remains secondary semantic evidence; real-window
		// screenshots/video are the pixel source of truth.
		recording = createTerminalRecording(context.evidenceDir, viewport);
		terminal = new Terminal({
			cols: viewport.cols,
			rows: viewport.rows,
			allowProposedApi: true,
			convertEol: false,
			scrollback: 1_000,
			termName: "xterm-256color",
		});
		lastFingerprint = screenFingerprint(snapshotScreen(terminal));
		processHandle = pty.spawn(config.command.argv[0], config.command.argv.slice(1), {
			name: "xterm-256color",
			cols: viewport.cols,
			rows: viewport.rows,
			cwd: config.command.cwd,
			env: launchEnvironment(config.command.env),
		});
		if (!Number.isInteger(processHandle.pid) || processHandle.pid <= 0) throw new Error("PTY launch did not return an owned process id");
		observations.push({ action: "launch", pid: processHandle.pid, argv0: path.basename(config.command.argv[0]), presentation: config.presentation });
		context.progress("tui_launched", { pid: processHandle.pid, cols: viewport.cols, rows: viewport.rows, presentation: config.presentation });

		if (nativeDisplay) {
			nativeDisplay.setInputHandler((data) => {
				if (!exited) processHandle.write(Buffer.from(data).toString("utf8"));
			});
		} else {
			terminal.onData((data) => {
				if (!exited) processHandle.write(data);
			});
		}
		processHandle.onData((data) => {
			lastDataAt = Date.now();
			const bytes = Buffer.from(data, "utf8");
			recording.recordOutput(data);
			if (nativeDisplay && !nativeDisplayFailure) {
				try { nativeDisplay.write(data); } catch (error) { nativeDisplayFailure = error; }
			}
			if (transcript.length < MAX_TRANSCRIPT_BYTES) {
				const kept = bytes.subarray(0, MAX_TRANSCRIPT_BYTES - transcript.length);
				transcript = Buffer.concat([transcript, kept]);
				if (kept.length < bytes.length) transcriptTruncated = true;
			} else transcriptTruncated = true;
			writeChain = writeChain.then(() => terminalWrite(terminal, data)).then(() => {
				const current = screenFingerprint(snapshotScreen(terminal));
				if (current !== lastFingerprint) {
					lastFingerprint = current;
					lastFrameChangeAt = Date.now();
				}
			});
		});
		processHandle.onExit((info) => {
			exited = true;
			exitInfo = info;
			resolveExit(info);
		});

		for (let index = 0; index < config.steps.length; index += 1) {
			if (nativeDisplayFailure) throw new Error(`native terminal mirror failed: ${safeReason(nativeDisplayFailure)}`);
			if (nativeDisplay && !nativeDisplay.connected()) throw new Error("native terminal mirror disconnected before the flow completed");
			const step = config.steps[index];
			context.progress("tui_action_started", { index, action: step.action });
			try {
				await executeStep({
					context,
					terminal,
					processHandle,
					step,
					index,
					assertions,
					observations,
					artifacts,
					recording,
					nativeDisplay,
					state: () => ({ exited, exitInfo, lastDataAt, lastFrameChangeAt, writeChain }),
					exitPromise,
				});
				context.progress("tui_action_finished", { index, action: step.action });
			} catch (error) {
				failure = new Error(`step ${index + 1} (${step.action}) failed: ${safeReason(error)}`);
				break;
			}
		}
		await writeChain;
		if (nativeDisplayFailure) throw new Error(`native terminal mirror failed: ${safeReason(nativeDisplayFailure)}`);
	} catch (error) {
		failure = error;
	} finally {
		try {
			await writeChain;
			const name = failure ? "failure" : "final";
			if (terminal) captureScreen({ context, terminal, name, artifacts, metadata: { exit: exitInfo ?? null } });
			if (nativeDisplay) await nativeDisplay.capture(name).catch((error) => {
				if (!failure) failure = new Error(`native terminal evidence capture failed: ${safeReason(error)}`);
			});
			const rawName = "raw-transcript.ansi";
			fs.writeFileSync(path.join(context.evidenceDir, rawName), transcript, { flag: "wx", mode: 0o600 });
			artifacts.terminalCaptures.push({ ...context.artifact(rawName, "raw terminal transcript"), format: "ansi", diagnosticOnly: true, truncated: transcriptTruncated });
		} catch (error) {
			if (!failure) failure = error;
		}
		if (processHandle) await cleanupOwnedPty(processHandle, () => exited, exitPromise);
		// Finalize after PTY cleanup so trailing output during the cleanup grace is
		// captured; finalize() awaits the async flush chain, is best-effort, and
		// never throws.
		if (recording) {
			observations.push({ action: "terminalRecording", ...(await recording.finalize(artifacts, context)), presentation: config.presentation });
			if (nativePresentation) {
				for (const artifact of artifacts.videos) if (artifact.format === "asciicast-v2") artifact.diagnosticOnly = true;
			}
		}
		if (nativeDisplay) await nativeDisplay.finish();
		terminal?.dispose();
	}

	return {
		status: failure ? "FAILED" : "PASSED",
		...(failure ? { reason: safeReason(failure) } : {}),
		assertions,
		observations: [...observations, { transcriptTruncated, exit: exitInfo ?? null }],
		artifacts,
	};
}

export function resolveTuiPresentation(flow) {
	const value = flow?.target?.command?.presentation ?? PTY_PRESENTATION;
	if (value !== PTY_PRESENTATION && value !== NATIVE_TERMINAL_PRESENTATION) {
		throw new Error(`target.command.presentation must be ${JSON.stringify(PTY_PRESENTATION)} or ${JSON.stringify(NATIVE_TERMINAL_PRESENTATION)}`);
	}
	return value;
}

async function executeStep(options) {
	const { context, terminal, processHandle, step, index, assertions, observations, artifacts, recording, nativeDisplay, state, exitPromise } = options;
	const timeoutMs = stepTimeout(step, context);
	switch (step.action) {
		case "waitForStable":
			await waitForStable(terminal, state, settleMs(step.settleMs), timeoutMs);
			observations.push({ action: step.action, stable: true });
			return;
		case "waitForText": {
			const text = boundedText(step.text, "waitForText.text");
			await waitFor(async () => {
				await state().writeChain;
				return visibleText(terminal).includes(text);
			}, timeoutMs, `visible screen did not contain ${JSON.stringify(text)}`);
			if (step.settleMs !== undefined) await waitForStable(terminal, state, settleMs(step.settleMs), timeoutMs);
			observations.push({ action: step.action, text });
			return;
		}
		case "sendText": {
			const text = boundedText(step.text, "sendText.text");
			if (/[ -]/u.test(text)) throw new Error("sendText cannot contain control characters; use sendKeys");
			if (state().exited) throw new Error("cannot send text after the PTY process exited");
			processHandle.write(text);
			observations.push({ action: step.action, characters: [...text].length });
			return;
		}
		case "sendKeys": {
			const sequences = keySequences(step.keys);
			if (state().exited) throw new Error("cannot send keys after the PTY process exited");
			for (const sequence of sequences) processHandle.write(sequence);
			observations.push({ action: step.action, keys: step.keys });
			return;
		}
		case "resize": {
			const cols = boundedInt(step.cols, 20, 300, "resize.cols");
			const rows = boundedInt(step.rows, 5, 120, "resize.rows");
			terminal.resize(cols, rows);
			if (!state().exited) processHandle.resize(cols, rows);
			recording.recordResize(cols, rows);
			await waitForStable(terminal, state, settleMs(step.settleMs), timeoutMs);
			observations.push({ action: step.action, cols, rows });
			return;
		}
		case "assertText": {
			const text = boundedText(step.text, "assertText.text");
			await state().writeChain;
			const passed = visibleText(terminal).includes(text);
			assertions.push({ action: step.action, expected: { visibleText: text }, passed });
			if (!passed) throw new Error(`visible screen does not contain ${JSON.stringify(text)}`);
			return;
		}
		case "assertNotText": {
			const text = boundedText(step.text, "assertNotText.text");
			await state().writeChain;
			const passed = !visibleText(terminal).includes(text);
			assertions.push({ action: step.action, expected: { absentVisibleText: text }, passed });
			if (!passed) throw new Error(`visible screen still contains ${JSON.stringify(text)}`);
			return;
		}
		case "assertCursor": {
			const row = boundedInt(step.row, 1, terminal.rows, "assertCursor.row");
			const column = boundedInt(step.column, 1, terminal.cols, "assertCursor.column");
			await state().writeChain;
			const screen = snapshotScreen(terminal);
			const passed = screen.cursor.row === row && screen.cursor.column === column;
			assertions.push({ action: step.action, expected: { row, column }, actual: screen.cursor, passed });
			if (!passed) throw new Error(`expected cursor ${row}:${column}, observed ${screen.cursor.row}:${screen.cursor.column}`);
			return;
		}
		case "assertProcessRunning": {
			const passed = !state().exited;
			assertions.push({ action: step.action, expected: "running", actual: passed ? "running" : "exited", passed });
			if (!passed) throw new Error(`PTY process exited early with code ${state().exitInfo?.exitCode ?? "unknown"}`);
			return;
		}
		case "assertProcessExited": {
			if (!state().exited) await waitForPromise(exitPromise, timeoutMs, "PTY process did not exit");
			const actual = state().exitInfo?.exitCode;
			const passed = step.exitCode === undefined || actual === step.exitCode;
			assertions.push({ action: step.action, expected: { exited: true, ...(step.exitCode === undefined ? {} : { exitCode: step.exitCode }) }, actual: state().exitInfo, passed });
			if (!passed) throw new Error(`expected exit code ${step.exitCode}, observed ${actual}`);
			return;
		}
		case "capture":
			await state().writeChain;
			{
				const name = `${index + 1}-${captureName(step.name)}`;
				captureScreen({ context, terminal, name, artifacts, metadata: { exit: state().exitInfo ?? null } });
				if (nativeDisplay) await nativeDisplay.capture(name);
			}
			return;
		default:
			throw new Error(`unsupported TUI action: ${step.action}`);
	}
}

function validateFlow(flow, projectRoot) {
	if (!isObject(flow.target?.command)) throw new Error("TUI target requires target.command");
	assertKnownFields(flow.target.command, new Set(["argv", "cwd", "env", "presentation"]), "target.command");
	const presentation = resolveTuiPresentation(flow);
	const rawArgv = flow.target.command.argv;
	if (!Array.isArray(rawArgv) || rawArgv.length < 1 || rawArgv.length > 64) throw new Error("target.command.argv must contain 1..64 strings");
	const argv = rawArgv.map((value, index) => requireString(value, `target.command.argv[${index}]`, MAX_ARG_LENGTH));
	const executable = path.basename(argv[0]).toLowerCase();
	if (BLOCKED_EXECUTABLES.has(executable)) throw new Error("TUI launch cannot invoke a shell or scripting host");
	if (["node", "node.exe", "bun", "bun.exe", "python", "python3", "python.exe", "ruby", "perl"].includes(executable) && INLINE_CODE_FLAGS.has((argv[1] ?? "").toLowerCase())) {
		throw new Error("TUI launch cannot contain inline executable code");
	}
	const command = {
		argv,
		cwd: resolveProjectDirectory(projectRoot, flow.target.command.cwd ?? "."),
		env: validateEnv(flow.target.command.env),
	};
	validateLaunchContract(command.argv, command.cwd, projectRoot);
	const viewportValue = flow.viewport ?? {};
	if (!isObject(viewportValue)) throw new Error("viewport must be an object");
	assertKnownFields(viewportValue, new Set(["cols", "rows"]), "viewport");
	if (presentation === NATIVE_TERMINAL_PRESENTATION && flow.viewport !== undefined) {
		throw new Error("viewport is PTY-only; native-terminal presentation uses the real terminal window geometry");
	}
	const viewport = {
		cols: viewportValue.cols === undefined ? 80 : boundedInt(viewportValue.cols, 20, 300, "viewport.cols"),
		rows: viewportValue.rows === undefined ? 24 : boundedInt(viewportValue.rows, 5, 120, "viewport.rows"),
	};
	if (!Array.isArray(flow.steps) || flow.steps.length < 1 || flow.steps.length > 100) throw new Error("TUI flow requires 1..100 steps");
	const steps = flow.steps.map((step, index) => validateStep(step, index));
	if (presentation === NATIVE_TERMINAL_PRESENTATION) validateNativeTerminalSteps(steps);
	return { command, viewport, steps, presentation };
}

export function validateNativeTerminalSteps(steps) {
	for (const step of steps) {
		if (!NATIVE_TERMINAL_ACTIONS.has(step.action)) {
			throw new Error(`TUI action ${step.action} is PTY-only and cannot be used with native-terminal presentation`);
		}
	}
	return steps;
}

function validateLaunchContract(argv, cwd, projectRoot) {
	const executable = argv[0];
	const base = path.basename(executable).toLowerCase();
	if (path.isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
		const resolved = path.resolve(cwd, executable);
		if (fs.existsSync(resolved) && fs.realpathSync(resolved) === fs.realpathSync(process.execPath)) {
			validateRuntimeScript(base, argv, cwd, projectRoot);
			return;
		}
		if (!isProjectFile(projectRoot, resolved, true)) throw new Error("TUI executable paths must resolve to a non-symlink executable inside the project");
		return;
	}
	if (["node", "node.exe", "python", "python3", "python.exe", "ruby", "perl", "deno", "deno.exe"].includes(base)) {
		validateRuntimeScript(base, argv, cwd, projectRoot);
		return;
	}
	if (base === "bun" || base === "bun.exe") {
		if (argv[1] === "run") {
			if (!/^[A-Za-z0-9:_-]+$/.test(argv[2] ?? "")) throw new Error("bun run requires a bounded package script name");
			return;
		}
		if (!isProjectFile(projectRoot, path.resolve(cwd, argv[1] ?? ""), false)) throw new Error("bun launch requires a project-local script or `bun run <script>`");
		return;
	}
	if (["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"].includes(base)) {
		const offset = argv[1] === "run" ? 2 : 1;
		if (!/^[A-Za-z0-9:_-]+$/.test(argv[offset] ?? "")) throw new Error(`${base} launch requires a bounded package script name`);
		if (argv[1] !== "run" && !["start", "test"].includes(argv[1])) throw new Error(`${base} launch must use run, start, or test`);
		return;
	}
	if (["cargo", "go", "dotnet"].includes(base) && argv[1] === "run") return;
	if (base === "java" && argv[1] === "-jar" && isProjectFile(projectRoot, path.resolve(cwd, argv[2] ?? ""), false)) return;
	throw new Error("TUI launch executable must be project-local or a bounded package/runtime launch contract");
}

function validateRuntimeScript(base, argv, cwd, projectRoot) {
	const scriptIndex = base.startsWith("deno") ? (argv[1] === "run" ? 2 : -1) : 1;
	if (scriptIndex < 1 || !argv[scriptIndex] || argv[scriptIndex].startsWith("-")) throw new Error(`${base} launch requires an explicit project-local script file`);
	if (!isProjectFile(projectRoot, path.resolve(cwd, argv[scriptIndex]), false)) throw new Error(`${base} script must be a non-symlink file inside the project`);
}

function isProjectFile(projectRoot, value, requireExecutable) {
	if (!isInside(projectRoot, value) || !fs.existsSync(value)) return false;
	let current = projectRoot;
	for (const part of path.relative(projectRoot, value).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		if (fs.lstatSync(current).isSymbolicLink()) return false;
	}
	const stat = fs.statSync(value);
	return stat.isFile() && (!requireExecutable || process.platform === "win32" || (stat.mode & 0o111) !== 0);
}

function validateStep(step, index) {
	if (!isObject(step) || typeof step.action !== "string" || !STEP_FIELDS[step.action]) throw new Error(`TUI step ${index + 1} has an unsupported action`);
	assertKnownFields(step, STEP_FIELDS[step.action], `TUI step ${index + 1}`);
	if (step.timeoutMs !== undefined) validateTimeout(step.timeoutMs);
	if (step.settleMs !== undefined) settleMs(step.settleMs);
	if (step.action === "assertProcessExited" && step.exitCode !== undefined && (!Number.isInteger(step.exitCode) || step.exitCode < 0 || step.exitCode > 255)) throw new Error("assertProcessExited.exitCode must be 0..255");
	return step;
}

function validateEnv(value) {
	if (value === undefined) return {};
	if (!isObject(value)) throw new Error("target.command.env must be an object");
	const result = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!SAFE_ENV.has(key) && !key.startsWith("PI_UI_QA_")) throw new Error(`target.command.env key is not allowed: ${key}`);
		result[key] = requireString(raw, `target.command.env.${key}`, MAX_ARG_LENGTH);
	}
	return result;
}

function launchEnvironment(extra) {
	const result = {};
	for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "USERPROFILE", "ComSpec"]) {
		if (process.env[key] !== undefined) result[key] = process.env[key];
	}
	return { ...result, TERM: "xterm-256color", PI_UI_QA: "1", ...extra };
}

function snapshotScreen(terminal) {
	const buffer = terminal.buffer.active;
	const rows = [];
	for (let row = 0; row < terminal.rows; row += 1) {
		rows.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
	}
	while (rows.length > 0 && rows.at(-1) === "") rows.pop();
	return {
		cols: terminal.cols,
		rows: terminal.rows,
		bufferType: buffer.type,
		cursor: { row: buffer.cursorY + 1, column: buffer.cursorX + 1 },
		lines: rows,
		text: rows.join("\n"),
	};
}

function visibleText(terminal) {
	return snapshotScreen(terminal).text;
}

function screenFingerprint(screen) {
	return JSON.stringify([screen.cols, screen.rows, screen.bufferType, screen.cursor.row, screen.cursor.column, screen.lines]);
}

async function waitForStable(terminal, state, settle, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let previous = "";
	let sameSince = Date.now();
	while (Date.now() < deadline) {
		await state().writeChain;
		const fingerprint = screenFingerprint(snapshotScreen(terminal));
		if (fingerprint !== previous) {
			previous = fingerprint;
			sameSince = Date.now();
		}
		const now = Date.now();
		if (now - sameSince >= settle && now - state().lastDataAt >= settle && now - state().lastFrameChangeAt >= settle) return;
		await sleep(Math.min(25, Math.max(1, deadline - now)));
	}
	throw new Error(`terminal screen did not settle for ${settle} ms`);
}

function captureScreen({ context, terminal, name, artifacts, metadata }) {
	const screen = snapshotScreen(terminal);
	const textName = `${name}.screen.txt`;
	const jsonName = `${name}.screen.json`;
	const header = `# terminal ${screen.cols}x${screen.rows} buffer=${screen.bufferType} cursor=${screen.cursor.row}:${screen.cursor.column}\n`;
	writePrivate(path.join(context.evidenceDir, textName), `${header}${screen.text}\n`);
	writePrivate(path.join(context.evidenceDir, jsonName), `${JSON.stringify({ ...screen, ...metadata }, null, 2)}\n`);
	artifacts.terminalCaptures.push({ ...context.artifact(textName, "terminal screen"), format: "text", bufferType: screen.bufferType });
	artifacts.terminalCaptures.push({ ...context.artifact(jsonName, "terminal screen state"), format: "json", bufferType: screen.bufferType });
}

// Builds a standards-compatible asciicast v2 recording (header plus time-coded
// output/resize events) from the PTY output stream. Events are timestamped on
// arrival, queued in order, and flushed by the async filesystem so a burst of
// PTY output never blocks the terminal write chain; the total file size stays
// bounded by the same limit as the raw transcript, and every failure is
// best-effort so a recording problem can never fail an otherwise valid QA run
// or alter screen-state assertions.
function createTerminalRecording(evidenceDir, viewport) {
	const file = path.join(evidenceDir, RECORDING_FILE);
	const startedAt = Date.now();
	const state = { bytes: 0, events: 0, truncated: false, headerOnly: true, reason: null };
	let active = true;
	let queue = Promise.resolve();
	const enqueue = (kind, payload) => {
		if (!active) return;
		const seconds = Number(Math.max(0, (Date.now() - startedAt) / 1000).toFixed(6));
		const line = `${JSON.stringify([seconds, kind, payload])}\n`;
		const length = Buffer.byteLength(line);
		if (state.bytes + length > MAX_TRANSCRIPT_BYTES) {
			state.truncated = true;
			active = false;
			return;
		}
		state.bytes += length;
		const buffer = Buffer.from(line, "utf8");
		queue = queue
			.then(() => fs.promises.appendFile(file, buffer))
			.then(
				() => {
					state.events += 1;
					state.headerOnly = false;
				},
				(error) => {
					state.reason = state.reason ?? safeReason(error);
					active = false;
				},
			);
	};
	try {
		const header = `${JSON.stringify({
			version: 2,
			width: viewport.cols,
			height: viewport.rows,
			timestamp: Math.floor(startedAt / 1000),
			env: { TERM: "xterm-256color" },
			title: "ui-qa terminal recording",
		})}\n`;
		fs.writeFileSync(file, header, { encoding: "utf8", flag: "wx", mode: 0o600 });
		state.bytes = Buffer.byteLength(header);
	} catch (error) {
		state.reason = safeReason(error);
		active = false;
	}
	return {
		recordOutput(data) {
			enqueue("o", typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
		},
		recordResize(cols, rows) {
			enqueue("r", `${cols}x${rows}`);
		},
		// Awaits the async flush chain so the artifact always reflects every
		// enqueued event; best-effort and never throws.
		async finalize(artifacts, context) {
			await queue.catch(() => {});
			if (state.reason) {
				try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
				return { status: "unavailable", reason: state.reason, ...(state.headerOnly ? {} : { truncated: state.truncated }) };
			}
			try {
				const stat = fs.statSync(file);
				if (!stat.isFile()) throw new Error("terminal recording was not created");
				if (state.headerOnly) throw new Error("terminal recording contains no terminal output");
				if (process.platform !== "win32") fs.chmodSync(file, 0o600);
				artifacts.videos.push({ ...context.artifact(RECORDING_FILE, "terminal recording"), format: "asciicast-v2", events: state.events, truncated: state.truncated });
				return { status: "recorded", events: state.events, truncated: state.truncated };
			} catch (error) {
				return { status: "unavailable", reason: safeReason(error) };
			}
		},
	};
}

async function cleanupOwnedPty(processHandle, exited, exitPromise) {
	try {
		if (exited()) return;
		terminateOwnedPty(processHandle, "SIGTERM");
		await Promise.race([exitPromise, sleep(CLEANUP_GRACE_MS)]);
		if (exited()) return;
		// Windows node-pty 1.1.0 has no signal-aware escalation: kill(signal)
		// throws before starting its owned ConPTY process-tree cleanup. One
		// signal-less kill above is therefore the Windows termination request;
		// repeating it would start a second async console-process-list helper.
		if (process.platform !== "win32") terminateOwnedPty(processHandle, "SIGKILL");
	} finally {
		await releaseWindowsPtyResources(processHandle);
	}
}

export function terminateOwnedPty(processHandle, signal, platform = process.platform) {
	try {
		if (platform === "win32") processHandle.kill();
		else processHandle.kill(signal);
	} catch { /* already exited or unsupported by the PTY implementation */ }
	if (platform !== "win32") {
		try { process.kill(-processHandle.pid, signal); } catch { /* node-pty may already have reaped the group */ }
	}
}

/**
 * @lydell/node-pty 1.1.0 leaves Windows ConPTY host handles alive after a
 * natural child exit. The dedicated UI QA runner has no more PTY work after
 * backend cleanup, so release those handles explicitly instead of keeping the
 * runner process alive indefinitely.
 *
 * This is best-effort and Windows-only because these members are node-pty
 * implementation details and must never affect an already-settled QA result.
 */
export async function releaseWindowsPtyResources(processHandle, platform = process.platform) {
	if (platform !== "win32") return;
	const agent = processHandle?._agent;
	for (const socket of [agent?.inSocket, agent?.outSocket]) {
		try { socket?.destroy?.(); } catch { /* best effort */ }
	}
	try {
		if (agent?._closeTimeout) clearTimeout(agent._closeTimeout);
	} catch { /* best effort */ }
	const conout = agent?._conoutSocketWorker;
	try { conout?.dispose?.(); } catch { /* best effort */ }
	try {
		if (conout?._drainTimeout) clearTimeout(conout._drainTimeout);
	} catch { /* best effort */ }
	try { await conout?._worker?.terminate?.(); } catch { /* best effort */ }
}

function keySequences(value) {
	if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new Error("sendKeys.keys must contain 1..100 named keys");
	return value.map((raw) => {
		const key = requireString(raw, "sendKeys key", 32).toLowerCase().replace(/[ _-]/g, "");
		if (KEY_SEQUENCES[key]) return KEY_SEQUENCES[key];
		const control = /^ctrl\+([a-z])$/.exec(raw.toLowerCase());
		if (control) return String.fromCharCode(control[1].charCodeAt(0) - 96);
		throw new Error(`unsupported named key: ${raw}`);
	});
}

function resolveProjectDirectory(projectRoot, value) {
	const requested = path.resolve(projectRoot, requireString(value, "target.command.cwd", MAX_ARG_LENGTH));
	if (!isInside(projectRoot, requested) || !fs.existsSync(requested)) throw new Error("target.command.cwd must be an existing project-local directory");
	let current = projectRoot;
	for (const part of path.relative(projectRoot, requested).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		if (fs.lstatSync(current).isSymbolicLink()) throw new Error("target.command.cwd must not contain symlinks");
	}
	const real = fs.realpathSync(requested);
	if (!isInside(projectRoot, real) || !fs.statSync(real).isDirectory()) throw new Error("target.command.cwd must be a project-local directory");
	return real;
}

function stepTimeout(step, context) {
	const value = step.timeoutMs ?? Math.min(15_000, context.stageTimeoutMs);
	validateTimeout(value);
	const remaining = context.deadline - Date.now();
	if (remaining <= 0) throw new Error("UI QA runner deadline expired");
	return Math.max(1, Math.min(Math.round(value), remaining));
}

function validateTimeout(value) {
	if (!Number.isFinite(value) || value < 50 || value > 30_000) throw new Error("step timeoutMs must be between 50 and 30000");
}

function settleMs(value) {
	const result = value ?? 150;
	if (!Number.isFinite(result) || result < 50 || result > 2_000) throw new Error("settleMs must be between 50 and 2000");
	return Math.round(result);
}

async function waitFor(check, timeoutMs, reason) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
	}
	throw new Error(reason);
}

function terminalWrite(terminal, data) {
	return new Promise((resolve) => terminal.write(data, resolve));
}

function waitForPromise(promise, timeoutMs, reason) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}

function boundedText(value, label) {
	return requireString(value, label, 4096);
}

function boundedInt(value, min, max, label) {
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
	return value;
}

function captureName(value) {
	const result = value === undefined ? "capture" : requireString(value, "capture.name", 80);
	if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new Error("capture.name must contain only letters, digits, underscore, or dash");
	return result;
}

function assertKnownFields(value, allowed, label) {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
}

function requireString(value, label, maxLength = 4096) {
	if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value.includes("\0")) throw new Error(`${label} must be a non-empty string no longer than ${maxLength}`);
	return value;
}

function writePrivate(file, content) {
	fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function emptyArtifacts() {
	return { screenshots: [], videos: [], traces: [], terminalCaptures: [], accessibilitySnapshots: [], observations: [], downloads: [] };
}

function isInside(root, target) {
	const relative = path.relative(root, target);
	return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeReason(error) {
	return error instanceof Error ? error.message : String(error);
}
