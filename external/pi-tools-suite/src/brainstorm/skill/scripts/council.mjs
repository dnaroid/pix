#!/usr/bin/env node
// Deterministic helper for the brainstorm skill. Prints one JSON object.
// Exit codes: 0 ok, 3 pending (wait and collect again), 2 usage/validation
// (run state untouched), 1 run marked incomplete.
import { readFile } from "node:fs/promises";
import { abortCouncil, collectRound, councilStatus, finalizeCouncil, initCouncil, reviewCouncil } from "./lib/protocol.mjs";

const USAGE = `Usage:
  council.mjs init --mode brainstorm|audit (--topic <text>|--topic-file <f>) --brief-file <f> [--models p/m:effort,...]
  council.mjs collect --run <dir> [--missing p2=reason,...]
  council.mjs review --run <dir> --draft-file <f>
  council.mjs finalize --run <dir> --proposal-file <f> --notes-file <f> [--publish]
  council.mjs status --run <dir>
  council.mjs abort --run <dir> [--reason <text>]
Files may be "-" for stdin. Run from the project root (or pass --cwd).`;

const FLAGS = new Set(["publish"]);

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const options = {};
	for (let i = 0; i < rest.length; i++) {
		const match = /^--([a-z-]+)(?:=(.*))?$/.exec(rest[i]);
		if (!match) throw Object.assign(new Error(`Unexpected argument: ${rest[i]}\n${USAGE}`), { code: 2 });
		const name = match[1].replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
		if (FLAGS.has(match[1])) { options[name] = true; continue; }
		const value = match[2] ?? rest[++i];
		if (value === undefined) throw Object.assign(new Error(`--${match[1]} needs a value\n${USAGE}`), { code: 2 });
		options[name] = value;
	}
	return { command, options };
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

async function text(options, name, label) {
	const file = options[`${name}File`];
	if (file === undefined) {
		if (typeof options[name] === "string") return options[name];
		throw Object.assign(new Error(`${label} is required (--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-file)`), { code: 2 });
	}
	return file === "-" ? readStdin() : readFile(file, "utf8");
}

async function main() {
	const { command, options } = parseArgs(process.argv.slice(2));
	const cwd = options.cwd ?? process.cwd();
	const base = { cwd, run: options.run };
	switch (command) {
		case "init":
			return initCouncil({ cwd, mode: options.mode, topic: (await text(options, "topic", "Topic")).trim(), brief: await text(options, "brief", "Brief"), models: options.models });
		case "collect":
			return collectRound({ ...base, missing: options.missing });
		case "review":
			return reviewCouncil({ ...base, draft: await text(options, "draft", "Draft") });
		case "finalize":
			return finalizeCouncil({ ...base, proposal: await text(options, "proposal", "Proposal"), notes: await text(options, "notes", "Revision notes"), publish: options.publish === true });
		case "status":
			return councilStatus(base);
		case "abort":
			return abortCouncil({ ...base, reason: options.reason });
		default:
			throw Object.assign(new Error(USAGE), { code: 2 });
	}
}

try {
	const result = await main();
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	process.exitCode = result?.status === "pending" ? 3 : 0;
} catch (error) {
	const code = typeof error?.code === "number" ? error.code : 2;
	process.stdout.write(`${JSON.stringify({ status: code === 1 ? "incomplete" : "error", error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
	process.exitCode = code;
}
