// Worker spec transport for owned-launch. The parent's borrowed
// environment, argv, and cwd travel through a 0600 spec file inside the
// 0700 run directory — never through inherited process environment or
// argv — so the launchd jobs receive exactly the payload environment the
// gate reconstructs, and nothing leaks through launchd's own environment.
//
// File format (strictly positional; the native parser never searches
// inside payload bytes, so arg/env values may contain newlines, '=', and
// any non-NUL bytes safely):
//   version=1
//   command=<path>
//   cwd=<path>
//   sockets_dir=<path>
//   supervisor_binary=<path>
//   gate_binary=<path>
//   label_supervisor=<label>
//   label_worker=<label>
//   watchdog_seconds=<n>
//   release_timeout_seconds=<n>
//   drain_deadline_seconds=<n>
//   args_count=<n>
//   env_count=<n>
//   arg:<i>:<bytelen>=<bytelen raw bytes>\n
//   env:<i>:<bytelen>=<bytelen raw bytes>\n   (entry is "NAME=value")
// All scalar lines precede all payload lines; arg entries precede env
// entries; every line ends with \n.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidOwnedLaunchLabel } from "./label.js";

export const OWNED_LAUNCH_SPEC_VERSION = 1 as const;
export const OWNED_LAUNCH_SPEC_FILE = "spec.txt";

export interface OwnedLaunchWorkerSpec {
	version: typeof OWNED_LAUNCH_SPEC_VERSION;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	socketsDir: string;
	supervisorBinary: string;
	gateBinary: string;
	labelSupervisor: string;
	labelWorker: string;
	watchdogSeconds: number;
	releaseTimeoutSeconds: number;
	drainDeadlineSeconds: number;
}

const MAX_PATH_BYTES = 4095;
const MAX_ITEMS = 8192;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export class OwnedLaunchSpecError extends Error {}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/** Validate every field the strict native parser enforces; throws {@link OwnedLaunchSpecError}. */
export function validateOwnedLaunchSpec(spec: OwnedLaunchWorkerSpec): void {
	const pathField = (name: string, value: string) => {
		if (!value || byteLength(value) > MAX_PATH_BYTES) {
			throw new OwnedLaunchSpecError(`spec.${name} must be 1..${MAX_PATH_BYTES} bytes`);
		}
	};
	pathField("command", spec.command);
	pathField("cwd", spec.cwd);
	pathField("socketsDir", spec.socketsDir);
	pathField("supervisorBinary", spec.supervisorBinary);
	pathField("gateBinary", spec.gateBinary);
	if (!isValidOwnedLaunchLabel(spec.labelSupervisor) || !isValidOwnedLaunchLabel(spec.labelWorker)) {
		throw new OwnedLaunchSpecError("spec labels must be valid owned-launch labels");
	}
	if (spec.labelSupervisor === spec.labelWorker) {
		throw new OwnedLaunchSpecError("supervisor and worker labels must differ");
	}
	if (!Array.isArray(spec.args) || spec.args.length > MAX_ITEMS) {
		throw new OwnedLaunchSpecError(`spec.args must be an array of at most ${MAX_ITEMS}`);
	}
	for (const [i, arg] of spec.args.entries()) {
		if (byteLength(arg) > MAX_PATH_BYTES) {
			throw new OwnedLaunchSpecError(`spec.args[${i}] exceeds ${MAX_PATH_BYTES} bytes`);
		}
	}
	const envEntries = Object.entries(spec.env);
	if (envEntries.length > MAX_ITEMS) {
		throw new OwnedLaunchSpecError(`spec.env must have at most ${MAX_ITEMS} entries`);
	}
	for (const [key, value] of envEntries) {
		if (!key || key.includes("=") || key.includes("\0") || value.includes("\0")) {
			throw new OwnedLaunchSpecError(`spec.env has invalid entry: ${key}`);
		}
		if (byteLength(`${key}=${value}`) > MAX_PATH_BYTES) {
			throw new OwnedLaunchSpecError(`spec.env[${key}] exceeds ${MAX_PATH_BYTES} bytes`);
		}
	}
	for (const [name, value] of [
		["watchdogSeconds", spec.watchdogSeconds],
		["releaseTimeoutSeconds", spec.releaseTimeoutSeconds],
		["drainDeadlineSeconds", spec.drainDeadlineSeconds],
	] as const) {
		if (!Number.isInteger(value) || value <= 0 || value > 7 * 24 * 3600) {
			throw new OwnedLaunchSpecError(`spec.${name} must be a positive bounded integer`);
		}
	}
}

/** Serialize the spec into the positional native format (validate first). */
export function serializeOwnedLaunchSpec(spec: OwnedLaunchWorkerSpec): string {
	validateOwnedLaunchSpec(spec);
	const scalars: Array<[string, string]> = [
		["version", String(spec.version)],
		["command", spec.command],
		["cwd", spec.cwd],
		["sockets_dir", spec.socketsDir],
		["supervisor_binary", spec.supervisorBinary],
		["gate_binary", spec.gateBinary],
		["label_supervisor", spec.labelSupervisor],
		["label_worker", spec.labelWorker],
		["watchdog_seconds", String(spec.watchdogSeconds)],
		["release_timeout_seconds", String(spec.releaseTimeoutSeconds)],
		["drain_deadline_seconds", String(spec.drainDeadlineSeconds)],
		["args_count", String(spec.args.length)],
		["env_count", String(Object.keys(spec.env).length)],
	];
	const lines: string[] = [];
	for (const [key, value] of scalars) {
		if (value.includes("\n") || value.includes("\0")) {
			throw new OwnedLaunchSpecError(`spec.${key} must be a single line without NUL`);
		}
		lines.push(`${key}=${value}\n`);
	}
	for (const [i, arg] of spec.args.entries()) {
		const bytes = Buffer.from(arg, "utf8");
		lines.push(`arg:${i}:${bytes.length}=`);
		lines.push(arg);
		lines.push("\n");
	}
	for (const [i, [key, value]] of Object.entries(spec.env).entries()) {
		const entry = `${key}=${value}`;
		const bytes = Buffer.from(entry, "utf8");
		lines.push(`env:${i}:${bytes.length}=`);
		lines.push(entry);
		lines.push("\n");
	}
	const out = lines.join("");
	if (byteLength(out) > MAX_TOTAL_BYTES) {
		throw new OwnedLaunchSpecError(`serialized spec exceeds ${MAX_TOTAL_BYTES} bytes`);
	}
	return out;
}

/** Atomically write the spec file with 0600 permissions inside the run directory. */
export function writeOwnedLaunchSpec(runDir: string, spec: OwnedLaunchWorkerSpec): string {
	const path = join(runDir, OWNED_LAUNCH_SPEC_FILE);
	writeFileSync(path, serializeOwnedLaunchSpec(spec), { mode: 0o600, flag: "wx" });
	return path;
}
