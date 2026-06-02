import { resolve } from "node:path";
import { parseThemeName, type ThemeName } from "../theme.js";
import type { AppOptions } from "./types.js";

export type ResumeCommandOptions = {
	cwd: string;
	sessionPath: string;
};

export function usage(): string {
	return `Usage: pix [--cwd <path>] [--no-session] [--session <path>] [--theme dark|light] [--model <provider/model[:thinking]>]
	       pix update [--check] [--force]
	       pix install [--check]
	       npm run dev -- [--cwd <path>] [--no-session] [--session <path>] [--theme dark|light] [--model <provider/model[:thinking]>]

Examples:
	  pix --cwd ../pi-mono
	  pix --cwd ../pi-mono --theme light --model anthropic/claude-sonnet-4-20250514:medium
	  pix update --check
	  pix install --check`;
}

export function parseArgs(argv: string[]): AppOptions {
	let cwd = process.cwd();
	let sessionPath: string | undefined;
	let modelRef: string | undefined;
	let noSession = false;
	let themeName: ThemeName = "dark";

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			console.log(usage());
			process.exit(0);
		}
		if (arg === "--cwd") {
			const value = argv[index + 1];
			if (!value) throw new Error("Missing value for --cwd");
			cwd = resolve(value);
			index += 1;
			continue;
		}
		if (arg === "--model") {
			const value = argv[index + 1];
			if (!value) throw new Error("Missing value for --model");
			modelRef = value;
			index += 1;
			continue;
		}
		if (arg === "--session") {
			const value = argv[index + 1];
			if (!value) throw new Error("Missing value for --session");
			sessionPath = resolve(value);
			index += 1;
			continue;
		}
		if (arg === "--theme") {
			const value = argv[index + 1];
			if (!value) throw new Error("Missing value for --theme");
			const parsedThemeName = parseThemeName(value);
			if (!parsedThemeName) throw new Error(`Unknown theme: ${value}`);
			themeName = parsedThemeName;
			index += 1;
			continue;
		}
		if (arg === "--no-session") {
			noSession = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
	}

	if (noSession && sessionPath) throw new Error("--session cannot be used with --no-session");

	return {
		cwd,
		themeName,
		noSession,
		...(sessionPath === undefined ? {} : { sessionPath }),
		...(modelRef === undefined ? {} : { modelRef }),
	};
}

export function formatResumeCommand(options: ResumeCommandOptions): string {
	return ["pix", "--cwd", options.cwd, "--session", options.sessionPath].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
