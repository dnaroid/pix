#!/usr/bin/env node

import net from "node:net";

const args = parseArgs(process.argv.slice(2));
const socket = net.createConnection({ host: "127.0.0.1", port: args.port });

socket.once("connect", () => {
	const handshake = {
		token: args.token,
		pid: process.pid,
		ppid: process.ppid,
		cols: boundedDimension(process.stdout.columns, 80),
		rows: boundedDimension(process.stdout.rows, 24),
	};
	socket.write(`${JSON.stringify(handshake)}\n`);
	if (process.stdin.isTTY) process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", (chunk) => socket.write(chunk));
});

socket.on("data", (chunk) => process.stdout.write(chunk));
socket.on("end", () => process.exit(0));
socket.on("error", (error) => {
	process.stderr.write(`native terminal bridge failed: ${error.message}\n`);
	process.exit(1);
});

function parseArgs(values) {
	const result = {};
	for (let index = 0; index < values.length; index += 2) {
		const key = values[index];
		const value = values[index + 1];
		if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid bridge argument: ${key ?? "(missing)"}`);
		result[key.slice(2)] = value;
	}
	const port = Number(result.port);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("native terminal bridge requires a valid --port");
	if (!/^[a-f0-9]{32,128}$/.test(result.token ?? "")) throw new Error("native terminal bridge requires a valid --token");
	return { port, token: result.token };
}

function boundedDimension(value, fallback) {
	return Number.isInteger(value) && value >= 10 && value <= 500 ? value : fallback;
}
