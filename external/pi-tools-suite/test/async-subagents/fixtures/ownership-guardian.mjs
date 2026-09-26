// Group member and sole cleanup authority. No provider stdout/stderr handles.
import net from "node:net";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";

const [socketPath, credential, groupText, pidFile] = process.argv.slice(2);
const group = Number(groupText);
let armed = false;
let stopped = false;
const stop = () => {
	if (stopped) return;
	stopped = true;
	if (armed) {
		try { process.kill(-group, "SIGKILL"); }
		catch (error) { if (error.code !== "ESRCH") process.stderr.write(`${error}\n`); }
	}
	process.exit(1);
};
process.on("disconnect", stop);
process.on("SIGTERM", stop);
writeFileSync(pidFile, String(process.pid));
// A captured PGID is safe only while this guardian itself remains a member.
// This prototype requires the wrapper to be a launch-time detached leader and
// the guardian to be spawned non-detached. It cannot guard arbitrary wrappers.
execFile("ps", ["-o", "pgid=", "-p", String(process.pid)], { timeout: 1000 }, (error, stdout) => {
	if (error || Number(stdout.trim()) !== group || !process.connected) return stop();
	const socket = net.connect(socketPath);
	let reply = "";
	socket.on("connect", () => socket.write(`${credential}\n`));
	socket.on("data", (bytes) => {
		reply += bytes;
		if (reply.length > 1024) return stop();
		if (reply.includes("\n")) {
			if (reply !== "OK\n") return stop();
			armed = true;
			process.send?.({ stage: "ready", pid: process.pid });
		}
	});
	socket.on("end", stop);
	socket.on("error", stop);
	socket.on("close", stop);
});
setTimeout(stop, 15000).unref(); // fixture backstop, not cleanup proof
