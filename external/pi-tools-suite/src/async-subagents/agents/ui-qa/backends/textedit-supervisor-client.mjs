import { spawn } from "node:child_process";

const MAX_OUTPUT = 1024 * 1024;

// Private pipes address this helper process, never a PID supplied by the caller.
// Killing a wedged helper below cannot grant authority over its LS-launched app.
export function createTextEditSupervisor(helper, { cwd = process.cwd(), spawnProcess = spawn, releaseMs = 5_000 } = {}) {
	const child = spawnProcess(helper.file, [...helper.argsPrefix, "textedit-supervisor"], {
		cwd, stdio: ["pipe", "pipe", "pipe"], detached: false,
	});
	let nextID = 0;
	let pending;
	let buffer = "";
	let bytes = 0;
	let closed = false;
	let revoked = false;
	let cleanup = "unknown";
	let launchSent = false;
	let releaseDetails = {};
	let closing;
	let stderr = "";
	let resolveExit;
	const exit = new Promise((resolve) => { resolveExit = resolve; });
	function rejectPending(error) {
		if (!pending) return;
		clearTimeout(pending.timer);
		const current = pending;
		pending = undefined;
		current.reject(error);
	}
	function revoke(reason) {
		revoked = true;
		rejectPending(new Error(reason));
		if (!child.stdin.destroyed) child.stdin.end(); // EOF permanently revokes native input.
	}
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		bytes += Buffer.byteLength(chunk);
		if (bytes > MAX_OUTPUT) { revoke("supervisor output exceeded limit"); return; }
		buffer += chunk.toString("utf8");
		let end;
		while ((end = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			try {
				const message = JSON.parse(line);
				if (typeof message.ok !== "boolean" || !message.result || typeof message.result !== "object") throw new Error("invalid envelope");
				if (message.result.cleanup !== undefined) {
					if (!["manualRequired", "confirmed", "unknown", "notNeeded"].includes(message.result.cleanup)) throw new Error("invalid cleanup");
					cleanup = message.result.cleanup;
					releaseDetails = message.result;
					if (pending) throw new Error("cleanup cannot resolve an active command");
				}
				if (!pending || message.id !== pending.id) {
					if (!revoked && message.result.cleanup === undefined) throw new Error("unexpected response id");
					continue;
				}
				const current = pending;
				pending = undefined;
				clearTimeout(current.timer);
				if (message.ok) current.resolve(message.result);
				else { revoked = true; current.reject(new Error(message.result.error || "supervisor refused command")); }
			} catch (error) { revoke(`invalid supervisor response: ${error.message}`); }
		}
	});
	child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(0, 4096); });
	child.stdin.on("error", (error) => revoke(`supervisor pipe failed: ${error.message}`));
	child.once("error", (error) => { revoke(`supervisor failed: ${error.message}`); });
	child.once("close", () => {
		closed = true;
		revoked = true;
		rejectPending(new Error(`supervisor exited before response${stderr ? `: ${stderr}` : ""}`));
		resolveExit();
	});
	return {
		request(command, timeoutMs) {
			if (!["launch", "prepare", "smoke", "snapshot"].includes(command)) return Promise.reject(new Error("unsupported supervisor command"));
			if (closed || revoked || closing || pending) return Promise.reject(new Error("supervisor unavailable or busy"));
			return new Promise((resolve, reject) => {
				const id = ++nextID;
				pending = { id, resolve, reject, timer: setTimeout(() => revoke(`${command} supervisor timeout`), Math.max(1, timeoutMs)) };
				if (command === "launch") launchSent = true;
				child.stdin.write(`${JSON.stringify({ id, command })}\n`);
			});
		},
		cancel: revoke,
		close() {
			if (closing) return closing;
			revoked = true;
			rejectPending(new Error("supervisor cleanup requested"));
			if (!closed && !child.stdin.destroyed && !child.stdin.writableEnded) {
				child.stdin.end(`${JSON.stringify({ id: ++nextID, command: "cleanup" })}\n`);
			}
			closing = (async () => {
				let timer;
				await Promise.race([exit, new Promise((resolve) => { timer = setTimeout(resolve, releaseMs); })]);
				clearTimeout(timer);
				if (!closed) {
					// Only the directly spawned helper; never PID/group traversal.
					child.kill("SIGKILL");
					cleanup = "unknown";
				}
				const manualCloseRequired = cleanup === "confirmed" || cleanup === "notNeeded" ? false : launchSent;
				return { ...releaseDetails, cleanup, manualCloseRequired, helperReleased: closed,
					...(cleanup === "unknown" && launchSent ? { manualCloseReason: "Launch was requested but its outcome is unknown; inspect TextEdit before closing or relaunching." } : {}),
					...(stderr ? { helperDiagnostic: stderr } : {}) };
			})();
			return closing;
		},
	};
}
