// Offline-only C + leaf. Each actor has an independent watchdog AND an
// authenticated-by-private-path, test-owned socket EOF cleanup channel.
import { spawn } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const [mode, dir, socketPath, topology] = process.argv.slice(2);
const mark = (name) => {
	writeFileSync(join(dir, `${name}-at`), String(Date.now()));
	writeFileSync(join(dir, name), String(process.pid)); // pid marker is published last
};
const watchdog = setTimeout(() => process.exit(124), mode === "leaf" ? 18_000 : 16_000);
watchdog.unref();
const socket = connect(socketPath);
socket.on("error", () => process.exit(98));
socket.on("close", () => process.exit(0));
socket.on("connect", () => {
	if (mode === "leaf") { process.on("SIGTERM", () => {}); mark("leaf"); return; }
	const leaf = spawn(process.execPath, [process.argv[1], "leaf", dir, socketPath, topology], {
		stdio: "ignore", detached: topology === "escape",
	});
	leaf.on("error", () => process.exit(98));
	mark("cli");
	const tick = () => {
		if (topology === "escape" && existsSync(join(dir, "complete"))) process.exit(0);
		setTimeout(tick, 20);
	};
	tick();
});
