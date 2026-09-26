// Offline fake Pi owner: a private, authenticated, per-owner Unix socket.
import net from "node:net";
import { chmodSync, writeFileSync } from "node:fs";

const [socketPath, credential, pidFile] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));
let authorized = false;
const clients = new Set();
const server = net.createServer((client) => {
	clients.add(client);
	client.on("close", () => clients.delete(client));
	let input = "";
	client.on("data", (bytes) => {
		input += bytes;
		if (input.length > 1024) return client.destroy();
		const newline = input.indexOf("\n");
		if (newline < 0) return;
		const value = input.slice(0, newline);
		input = "";
		if (!authorized || value !== credential) return client.destroy();
		client.write("OK\n");
	});
});
server.listen(socketPath, () => {
	chmodSync(socketPath, 0o600);
	process.send?.({ stage: "listening", pid: process.pid });
});
process.on("message", (message) => {
	if (message === "authorize") {
		authorized = true;
		process.send?.({ stage: "authorized" });
	}
});
// Fixture safety net only. Not part of the ownership mechanism.
setTimeout(() => process.exit(1), 15000).unref();
