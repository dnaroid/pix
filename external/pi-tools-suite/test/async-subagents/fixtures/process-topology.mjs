// Offline OS topology only: this does not invoke Pi, Claude, or a provider.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [mode, marker, pidFile] = process.argv.slice(2);
// Last-resort bound if the test fails before learning a detached leaf's PID.
// This is only a fixture safety net, not evidence of production tree ownership.
setTimeout(() => process.exit(1), 12_000);
if (mode === "leaf") {
	// Persist identity before the IPC readiness message, so a failed handshake
	// still leaves the test enough information to clean up a detached leaf.
	if (pidFile) writeFileSync(pidFile, String(process.pid));
	process.on("SIGTERM", () => {
		if (marker) writeFileSync(marker, "SIGTERM");
		process.exit(0);
	});
	process.send?.({ ready: process.pid });
} else if (mode === "control") {
	process.stdout.write(`${JSON.stringify({ ready: process.pid })}\n`);
} else if (["same", "detached", "forward"].includes(mode)) {
	const leaf = spawn(process.execPath, [fileURLToPath(import.meta.url), "leaf", marker ?? "", pidFile ?? ""], {
		detached: mode !== "same",
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	if (leaf.pid && pidFile) writeFileSync(pidFile, String(leaf.pid));
	leaf.once("message", ({ ready }) => {
		process.stdout.write(`${JSON.stringify({ ready: process.pid, leaf: ready })}\n`);
	});
	leaf.once("error", (error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
	if (mode === "forward") {
		process.on("SIGTERM", () => leaf.kill("SIGTERM"));
		leaf.once("exit", () => process.exit(0));
	}
} else {
	throw new Error(`Unknown fixture mode: ${mode}`);
}

setInterval(() => {}, 1000);
