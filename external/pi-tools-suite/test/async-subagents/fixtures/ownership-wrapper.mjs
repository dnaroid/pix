// Offline stand-in for a detached-per-request provider wrapper, not integration.
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [socketPath, credential, dir, mode] = process.argv.slice(2);
const here = fileURLToPath(new URL(".", import.meta.url));
writeFileSync(`${dir}/wrapper`, String(process.pid));
let armed = false;
let stopping = false;
const fail = () => {
	if (stopping) return;
	stopping = true;
	if (armed) {
		try { process.kill(-process.pid, "SIGKILL"); }
		catch (error) { if (error.code !== "ESRCH") process.stderr.write(`${error}\n`); }
	}
	process.exit(1);
};
// Verify launch-time detached leadership before treating our PID as an owned PGID.
const ownGroup = () => new Promise((resolve, reject) => {
	execFile("ps", ["-o", "pgid=", "-p", String(process.pid)], { timeout: 1000 }, (error, stdout) => {
		if (error || Number(stdout.trim()) !== process.pid) reject(error ?? new Error("wrapper is not its group leader"));
		else resolve();
	});
});
const authenticate = () => new Promise((resolve, reject) => {
	const socket = net.connect(socketPath);
	let answer = "";
	socket.once("connect", () => socket.write(`${credential}\n`));
	socket.on("data", (chunk) => {
		answer += chunk;
		if (answer === "OK\n") resolve(socket);
		else if (answer.length > 1024 || answer.includes("\n")) reject(new Error("bad authorization"));
	});
	socket.once("error", reject);
	socket.once("close", () => reject(new Error("owner closed before authorization")));
});
try {
	const owner = await authenticate();
	owner.on("error", fail);
	owner.on("close", fail);
	if (process.ppid === 1) throw new Error("wrapper lost launcher");
	await ownGroup();
	if (owner.destroyed) throw new Error("owner lost before guardian");
	const guardian = spawn(process.execPath, [`${here}ownership-guardian.mjs`, socketPath, mode === "guardian-fail" ? "bad-guardian-credential" : credential, String(process.pid), `${dir}/guardian`], {
		stdio: ["ignore", "ignore", "ignore", "ipc"], detached: false,
	});
	const ready = await new Promise((resolve, reject) => {
		guardian.once("message", resolve);
		guardian.once("error", reject);
		guardian.once("exit", () => reject(new Error("guardian exited before ready")));
	});
	if (ready.stage !== "ready" || !guardian.connected || owner.destroyed) throw new Error("guardian not armed");
	armed = true;
	guardian.once("exit", fail);
	guardian.once("disconnect", fail);
	process.send?.({ stage: "guardian-ready", wrapper: process.pid, guardian: ready.pid });
	// Deterministic barrier: CLI cannot launch until the test releases it.
	await new Promise((resolve) => process.on("message", (message) => { if (message === "launch") resolve(); }));
	if (owner.destroyed || !guardian.connected) throw new Error("owner/guardian lost before CLI");
	const cli = spawn(process.execPath, [`${here}ownership-cli.mjs`, dir, mode], { detached: false, stdio: ["ignore", "ignore", "ignore", "ipc"] });
	cli.once("error", fail);
	if (cli.pid) writeFileSync(`${dir}/cli-launched`, String(cli.pid));
	process.send?.({ stage: "cli-launched", pid: cli.pid });
	process.on("message", (message) => {
		if (message === "complete" || message === "complete-fail") {
			try { cli.send(message, (error) => { if (error && error.code !== "ERR_IPC_CHANNEL_CLOSED") fail(); }); }
			catch (error) { if (error.code !== "ERR_IPC_CHANNEL_CLOSED") fail(); }
		}
	});
	cli.once("exit", (code, signal) => {
		// Test-only scheduler preemption at the real CLI exit callback, before
		// process.exit prevents queued guardian-loss callbacks from running.
		if (mode === "joint-race") {
			writeFileSync(`${dir}/cli-exit-stop-code`, String(signal ? 1 : code ?? 1));
			process.kill(process.pid, "SIGSTOP");
		}
		process.exit(signal ? 1 : code ?? 1);
	});
} catch (error) {
	process.stderr.write(`${error}\n`);
	fail();
}
