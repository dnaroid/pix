import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createMacosWindowEvidenceController, probeDesktopBackend } from "../../backends/desktop.mjs";

export const NATIVE_TERMINAL_PRESENTATION = "native-terminal";

const ITERM2_EXECUTABLE = "/Applications/iTerm.app/Contents/MacOS/iTerm2";
const MACOS_TERMINAL_EXECUTABLE = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
const BRIDGE_CLIENT = fileURLToPath(new URL("./bridge-client.mjs", import.meta.url));
const HANDSHAKE_MAX_BYTES = 4 * 1024;
const PENDING_INPUT_MAX_BYTES = 64 * 1024;
const CLEANUP_GRACE_MS = 1_000;

export async function probeNativeTerminalBackend(context) {
	const supportedCapabilities = [
		"launch", "nativeTerminalWindow", "ptyInput", "screenState", "ansiVt", "alternateScreen",
		"stableFrame", "visibleTextAssertions", "cursorAssertions", "processState", "terminalCapture",
		"terminalRecording", "ownedCleanup",
	];
	if (process.platform !== "darwin") {
		return {
			available: false,
			platformDriver: process.platform === "win32" ? "windows-terminal-window-planned" : "linux-terminal-window-planned",
			supportedCapabilities,
			missingCapabilities: ["windowScreenshot", "windowVideo"],
			reason: `native-terminal presentation is not implemented on ${process.platform}`,
			remediation: "use presentation=pty when pixel fidelity is not required, or add a native terminal-window driver for this platform",
		};
	}
	const provider = selectNativeTerminalProvider();
	if (!provider) {
		return {
			available: false,
			platformDriver: "macos-native-terminal-window",
			supportedCapabilities,
			missingCapabilities: ["nativeTerminalWindow", "windowScreenshot", "windowVideo"],
			reason: "no supported native terminal host is available",
			remediation: "install iTerm2, restore the system Terminal application, or use presentation=pty when pixel fidelity is not required",
		};
	}
	if (!fs.existsSync(BRIDGE_CLIENT)) {
		return {
			available: false,
			platformDriver: "macos-terminal-window",
			supportedCapabilities,
			missingCapabilities: ["nativeTerminalWindow", "windowScreenshot", "windowVideo"],
			reason: "the bundled native-terminal bridge client is unavailable",
			remediation: "restore the bundled UI QA native-terminal driver files",
		};
	}
	const desktop = await probeDesktopBackend(context);
	const screenshot = desktop.supportedCapabilities?.includes("windowScreenshot") === true;
	const supported = [...supportedCapabilities];
	if (screenshot) supported.push("windowScreenshot");
	if (desktop.supportedCapabilities?.includes("windowVideo")) supported.push("windowVideo");
	const missing = [];
	if (!screenshot) missing.push("windowScreenshot");
	if (!supported.includes("windowVideo")) missing.push("windowVideo");
	return {
		available: desktop.available && screenshot,
		platformDriver: provider.platformDriver,
		supportedCapabilities: supported,
		missingCapabilities: [...missing, "terminalResize"],
		reason: desktop.available && screenshot
			? `PTY control plus a runner-owned ${provider.displayName} mirror and exact-window capture are available for pixel-faithful terminal QA`
			: desktop.reason ?? "native-terminal presentation requires macOS Accessibility and Screen Recording permissions",
		remediation: desktop.available && !screenshot
			? "grant Screen Recording permission to the terminal/Pi host, then rerun"
			: desktop.remediation,
	};
}

export async function startNativeTerminalDisplay(context, observations, artifacts) {
	const provider = selectNativeTerminalProvider();
	if (!provider) throw new Error("no supported native terminal host is available");
	const token = randomBytes(32).toString("hex");
	const bridge = await createBridge(token);
	const commandFile = path.join(context.workspaceDir, `native-terminal-${context.runId}.command`);
	let host;
	let evidence;
	try {
		const command = nativeTerminalBridgeShellCommand({ nodePath: process.execPath, bridgePath: BRIDGE_CLIENT, port: bridge.port, token });
		if (provider.commandFile) {
			fs.writeFileSync(commandFile, nativeTerminalBridgeCommandFile({ command }), { encoding: "utf8", mode: 0o700, flag: "wx" });
			fs.chmodSync(commandFile, 0o700);
		}
		host = launchNativeTerminalProvider(provider, command, commandFile);
		if (!host.pid) throw new Error("native terminal host launch did not return a process id");
		const handshake = await bridge.waitForHandshake(15_000);
		if (provider.requireDescendantBridge && !isDescendantProcess(handshake.pid, host.pid)) {
			throw new Error("native terminal bridge did not originate from the runner-owned terminal process");
		}
		const selector = ["--pid", String(host.pid)];
		evidence = await createMacosWindowEvidenceController({ context, selector, observations, artifacts });
		observations.push({
			action: "nativeTerminalHost",
			presentation: NATIVE_TERMINAL_PRESENTATION,
			provider: provider.id,
			pid: host.pid,
			platformDriver: provider.platformDriver,
			cols: handshake.cols,
			rows: handshake.rows,
		});
		context.progress("tui_native_terminal_ready", { pid: host.pid, cols: handshake.cols, rows: handshake.rows });
		return nativeDisplayHandle({ bridge, evidence, host, commandFile, handshake });
	} catch (error) {
		await evidence?.finish().catch(() => {});
		await bridge.close().catch(() => {});
		if (host) await cleanupNativeTerminalHost(host);
		removeCommandFile(commandFile);
		throw error;
	}
}

export function nativeTerminalBridgeShellCommand({ nodePath, bridgePath, port, token }) {
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("native-terminal bridge port is invalid");
	if (!/^[a-f0-9]{32,128}$/.test(token)) throw new Error("native-terminal bridge token is invalid");
	return `exec ${shellQuoteTrustedPath(nodePath)} ${shellQuoteTrustedPath(bridgePath)} --port ${port} --token ${token}`;
}

export function nativeTerminalBridgeCommandFile({ command }) {
	if (typeof command !== "string" || !command.startsWith("exec ") || command.includes("\n") || command.includes("\r")) {
		throw new Error("native-terminal bridge command is invalid");
	}
	return `#!/bin/zsh\n${command}\n`;
}

export function chooseNativeTerminalProvider({ itermAvailable, terminalAvailable }) {
	if (itermAvailable) {
		return {
			id: "iterm2",
			displayName: "iTerm2",
			executable: ITERM2_EXECUTABLE,
			platformDriver: "macos-iterm2-window",
			commandFile: false,
			requireDescendantBridge: false,
		};
	}
	if (terminalAvailable) {
		return {
			id: "terminal-app",
			displayName: "Terminal.app",
			executable: MACOS_TERMINAL_EXECUTABLE,
			platformDriver: "macos-terminal-window",
			commandFile: true,
			requireDescendantBridge: true,
		};
	}
	return null;
}

function selectNativeTerminalProvider() {
	return chooseNativeTerminalProvider({
		itermAvailable: fs.existsSync(ITERM2_EXECUTABLE),
		terminalAvailable: fs.existsSync(MACOS_TERMINAL_EXECUTABLE),
	});
}

function launchNativeTerminalProvider(provider, command, commandFile) {
	const args = provider.commandFile ? [commandFile] : [`--command=${command}`];
	return spawn(provider.executable, args, { stdio: "ignore", detached: false, windowsHide: true });
}

function nativeDisplayHandle({ bridge, evidence, host, commandFile, handshake }) {
	let finished = false;
	return {
		viewport: { cols: handshake.cols, rows: handshake.rows },
		write(data) { bridge.write(data); },
		setInputHandler(handler) { bridge.setInputHandler(handler); },
		connected() { return bridge.connected(); },
		async capture(name) { await evidence.capture(name); },
		async finish() {
			if (finished) return;
			finished = true;
			await evidence.finish().catch(() => {});
			await bridge.close();
			await cleanupNativeTerminalHost(host);
			removeCommandFile(commandFile);
		},
	};
}

async function createBridge(token) {
	let socket;
	let authenticated = false;
	let closed = false;
	let inputHandler;
	let pendingInput = Buffer.alloc(0);
	let resolveHandshake;
	let rejectHandshake;
	const handshakePromise = new Promise((resolve, reject) => { resolveHandshake = resolve; rejectHandshake = reject; });
	const server = net.createServer((candidate) => {
		if (socket || authenticated || closed) {
			candidate.destroy();
			return;
		}
		socket = candidate;
		let header = Buffer.alloc(0);
		candidate.on("data", (chunk) => {
			if (authenticated) {
				forwardInput(chunk);
				return;
			}
			header = Buffer.concat([header, Buffer.from(chunk)]);
			if (header.length > HANDSHAKE_MAX_BYTES) {
				candidate.destroy();
				return;
			}
			const newline = header.indexOf(0x0a);
			if (newline < 0) return;
			const line = header.subarray(0, newline).toString("utf8");
			const remainder = header.subarray(newline + 1);
			try {
				const handshake = validateHandshake(line, token);
				authenticated = true;
				resolveHandshake(handshake);
				if (remainder.length > 0) forwardInput(remainder);
			} catch {
				candidate.destroy();
			}
		});
		candidate.once("error", () => {
			if (!authenticated && socket === candidate) socket = undefined;
		});
		candidate.once("close", () => {
			if (!authenticated && socket === candidate) socket = undefined;
		});
	});
	const forwardInput = (chunk) => {
		if (inputHandler) {
			inputHandler(chunk);
			return;
		}
		if (pendingInput.length >= PENDING_INPUT_MAX_BYTES) return;
		pendingInput = Buffer.concat([pendingInput, Buffer.from(chunk)]).subarray(0, PENDING_INPUT_MAX_BYTES);
	};
	server.once("error", (error) => rejectHandshake(error));
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("native terminal bridge did not bind a TCP port");
	return {
		port: address.port,
		async waitForHandshake(timeoutMs) { return waitForPromise(handshakePromise, timeoutMs, "native terminal bridge did not connect"); },
		write(data) {
			if (!authenticated || socket?.destroyed) throw new Error("native terminal bridge is not connected");
			socket.write(data);
		},
		setInputHandler(handler) {
			inputHandler = handler;
			if (pendingInput.length > 0) {
				const buffered = pendingInput;
				pendingInput = Buffer.alloc(0);
				handler(buffered);
			}
		},
		connected() { return authenticated && !closed && Boolean(socket) && !socket.destroyed; },
		async close() {
			if (closed) return;
			closed = true;
			try { socket?.end(); } catch { /* best effort */ }
			try { socket?.destroy(); } catch { /* best effort */ }
			await new Promise((resolve) => server.close(() => resolve()));
		},
	};
}

function validateHandshake(line, token) {
	let value;
	try { value = JSON.parse(line); } catch { throw new Error("native terminal bridge returned invalid handshake JSON"); }
	if (!isRecord(value) || value.token !== token) throw new Error("native terminal bridge authentication failed");
	const pid = boundedInteger(value.pid, 1, 2_147_483_647, "native terminal bridge pid");
	const ppid = boundedInteger(value.ppid, 1, 2_147_483_647, "native terminal bridge ppid");
	const cols = boundedInteger(value.cols, 10, 500, "native terminal cols");
	const rows = boundedInteger(value.rows, 10, 500, "native terminal rows");
	return { pid, ppid, cols, rows };
}

function isDescendantProcess(pid, ancestorPid) {
	if (!Number.isInteger(pid) || !Number.isInteger(ancestorPid) || pid <= 0 || ancestorPid <= 0) return false;
	let current = pid;
	const seen = new Set();
	for (let depth = 0; depth < 64 && current > 1 && !seen.has(current); depth += 1) {
		if (current === ancestorPid) return true;
		seen.add(current);
		try {
			const output = execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(current)], { encoding: "utf8", timeout: 1_000 }).trim();
			current = Number(output);
			if (!Number.isInteger(current) || current <= 0) return false;
		} catch {
			return false;
		}
	}
	return current === ancestorPid;
}

async function cleanupNativeTerminalHost(child) {
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	try { child.kill("SIGTERM"); } catch { /* already exited */ }
	await Promise.race([exited, sleep(CLEANUP_GRACE_MS)]);
	if (child.exitCode !== null || child.signalCode !== null) return;
	try { child.kill("SIGKILL"); } catch { /* already exited */ }
	await Promise.race([exited, sleep(CLEANUP_GRACE_MS)]);
}

function removeCommandFile(commandFile) {
	try { fs.rmSync(commandFile, { force: true }); } catch { /* best effort */ }
}

function shellQuoteTrustedPath(value) {
	if (typeof value !== "string" || value.length < 1 || value.includes("\n") || value.includes("\r") || value.includes(String.fromCharCode(0))) {
		throw new Error("native-terminal bridge path is invalid");
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function boundedInteger(value, min, max, label) {
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is invalid`);
	return value;
}

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function waitForPromise(promise, timeoutMs, reason) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}
