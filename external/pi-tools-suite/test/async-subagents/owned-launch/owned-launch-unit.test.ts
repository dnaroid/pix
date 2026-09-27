// Unit tests for the owned-launch TypeScript primitives. These run
// everywhere (no launchd, no native binaries, no signals): label shape,
// strict spec transport round-trips including hostile payload bytes,
// secure-directory creation, sockets-dir budget, and the fail-closed
// toolchain bootstrap contract.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OWNED_LAUNCH_LABEL_PREFIX,
	createSecureDir,
	isValidOwnedLaunchLabel,
	ownedLaunchLabel,
	resolveSocketsDir,
} from "../../../src/async-subagents/core/owned-launch/label.js";
import {
	OWNED_LAUNCH_CANCEL_MARKER,
	writeOwnedLaunchCancelMarker,
} from "../../../src/async-subagents/core/owned-launch/marker.js";
import {
	OwnedLaunchSpecError,
	serializeOwnedLaunchSpec,
	validateOwnedLaunchSpec,
	type OwnedLaunchWorkerSpec,
} from "../../../src/async-subagents/core/owned-launch/spec.js";
import { ensureOwnedLaunchBinaries, ownedLaunchNativeDir } from "../../../src/async-subagents/core/owned-launch/bootstrap.js";

function baseSpec(overrides: Partial<OwnedLaunchWorkerSpec> = {}): OwnedLaunchWorkerSpec {
	return {
		version: 1,
		command: "/usr/local/bin/pi",
		args: ["--mode", "rpc"],
		cwd: "/tmp",
		env: { PATH: "/usr/bin:/bin", HOME: "/Users/test" },
		socketsDir: "/tmp/sockets",
		supervisorBinary: "/cache/owned-launch-supervisor",
		gateBinary: "/cache/owned-launch-worker-gate",
		labelSupervisor: ownedLaunchLabel(),
		labelWorker: ownedLaunchLabel(),
		watchdogSeconds: 60,
		releaseTimeoutSeconds: 20,
		drainDeadlineSeconds: 30,
		...overrides,
	};
}

// Reference parser mirroring the strict native rules: single-line scalars
// first, then positional byte-length-prefixed arg entries, then env entries.
// The first '=' on each segment separates the key; payload bytes are
// consumed by explicit length, so embedded lookalikes cannot confuse it.
function parseSpec(text: string): { scalars: Record<string, string>; args: string[]; env: string[] } {
	const scalars: Record<string, string> = {};
	const args: string[] = [];
	const env: string[] = [];
	let pos = 0;
	while (pos < text.length) {
		const eq = text.indexOf("=", pos);
		if (eq < 0) throw new Error("missing '='");
		const key = text.slice(pos, eq);
		if (key.startsWith("arg:") || key.startsWith("env:")) {
			const len = Number(key.split(":")[2]);
			const value = text.slice(eq + 1, eq + 1 + len);
			if (text[eq + 1 + len] !== "\n") throw new Error("framing mismatch");
			(key.startsWith("arg:") ? args : env).push(value);
			pos = eq + 1 + len + 1;
			continue;
		}
		const nl = text.indexOf("\n", pos);
		if (nl < 0 || nl < eq) throw new Error("missing newline");
		scalars[key] = text.slice(eq + 1, nl);
		pos = nl + 1;
	}
	return { scalars, args, env };
}

describe("owned-launch labels", () => {
	test("generated labels are strictly valid and unique", () => {
		const a = ownedLaunchLabel();
		const b = ownedLaunchLabel();
		expect(a).not.toBe(b);
		expect(isValidOwnedLaunchLabel(a)).toBe(true);
		expect(isValidOwnedLaunchLabel(b)).toBe(true);
	});
	test("invalid shapes are rejected", () => {
		expect(isValidOwnedLaunchLabel("org.pix.owned-launch.not-a-uuid")).toBe(false);
		expect(isValidOwnedLaunchLabel("org.pix.other." + "a".repeat(36))).toBe(false);
		expect(isValidOwnedLaunchLabel("")).toBe(false);
		expect(isValidOwnedLaunchLabel(`${OWNED_LAUNCH_LABEL_PREFIX}../escape`)).toBe(false);
	});
});

describe("owned-launch spec transport", () => {
	test.skipIf(process.platform !== "darwin")("real native parser accepts length-prefixed newlines and rejects corrupt framing", () => {
		const dir = mkdtempSync(join(tmpdir(), "ol-native-spec-"));
		try {
			const exe = join(dir, "parse");
			const c = spawnSync("xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", ownedLaunchNativeDir(), join(import.meta.dir, "fixtures", "spec-parser.c"), "-lbsm", "-o", exe], { encoding: "utf8" });
			expect(c.status, c.stderr).toBe(0);
			const text = serializeOwnedLaunchSpec(baseSpec({ args: ["", "line1\nline2=foo"], env: { PROMPT: "a\nb=c" } }));
			writeFileSync(join(dir, "spec.txt"), text);
			expect(spawnSync(exe, [dir, "valid"]).status).toBe(0);
			writeFileSync(join(dir, "spec.txt"), text + "garbage\n");
			expect(spawnSync(exe, [dir, "invalid"]).status).toBe(0);
			writeFileSync(join(dir, "spec.txt"), text.replace(/arg:1:\d+=/, "arg:1:1="));
			expect(spawnSync(exe, [dir, "invalid"]).status).toBe(0);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	test.skipIf(process.platform !== "darwin")("native worker and journal parsers reject trailing bytes and out-of-range times", () => {
		const dir = mkdtempSync(join(tmpdir(), "ol-record-parser-"));
		try {
			const exe = join(dir, "parse");
			const c = spawnSync("xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", ownedLaunchNativeDir(), join(import.meta.dir, "fixtures", "record-parser.c"), "-lbsm", "-o", exe], { encoding: "utf8" });
			expect(c.status, c.stderr).toBe(0);
			expect(spawnSync(exe, []).status).toBe(0);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	test("round-trips scalars, args, and env", () => {
		const spec = baseSpec();
		const text = serializeOwnedLaunchSpec(spec);
		const parsed = parseSpec(text);
		expect(parsed.scalars.command).toBe(spec.command);
		expect(parsed.scalars.cwd).toBe(spec.cwd);
		expect(parsed.scalars.args_count).toBe("2");
		expect(parsed.scalars.env_count).toBe("2");
		expect(parsed.args).toEqual(spec.args);
		expect(parsed.env.sort()).toEqual(["HOME=/Users/test", "PATH=/usr/bin:/bin"].sort());
	});
	test("payload bytes with newlines, equals, and quotes survive framing", () => {
		const nasty = "line1\nline2=key with = and \"quotes\" and\nnewline";
		const spec = baseSpec({ args: ["--prompt", nasty], env: { PROMPT: nasty, PLAIN: "x" } });
		const parsed = parseSpec(serializeOwnedLaunchSpec(spec));
		expect(parsed.args[1]).toBe(nasty);
		expect(parsed.env.find((e) => e.startsWith("PROMPT="))).toBe(`PROMPT=${nasty}`);
	});
	test("validation fails closed on hostile fields", () => {
		expect(() => validateOwnedLaunchSpec(baseSpec({ labelSupervisor: "evil" }))).toThrow(OwnedLaunchSpecError);
		const label = ownedLaunchLabel();
		expect(() => validateOwnedLaunchSpec(baseSpec({ labelSupervisor: label, labelWorker: label }))).toThrow(OwnedLaunchSpecError);
		expect(() => validateOwnedLaunchSpec(baseSpec({ command: "" }))).toThrow(OwnedLaunchSpecError);
		expect(() => validateOwnedLaunchSpec(baseSpec({ env: { "BAD=KEY": "v" } }))).toThrow(OwnedLaunchSpecError);
		expect(() => validateOwnedLaunchSpec(baseSpec({ env: { NUL: "a\0b" } }))).toThrow(OwnedLaunchSpecError);
		expect(() => validateOwnedLaunchSpec(baseSpec({ watchdogSeconds: 0 }))).toThrow(OwnedLaunchSpecError);
		expect(() => validateOwnedLaunchSpec(baseSpec({ watchdogSeconds: 1.5 }))).toThrow(OwnedLaunchSpecError);
		expect(() => validateOwnedLaunchSpec(baseSpec({ args: ["a".repeat(5000)] }))).toThrow(OwnedLaunchSpecError);
	});
});

describe("owned-launch secure directories", () => {
	test("creates a fresh 0700 directory and refuses reuse", () => {
		const base = join(tmpdir(), `ol-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(base, { recursive: true });
		try {
			const dir = createSecureDir(base, "run-1");
			const st = statSync(dir);
			expect(st.isDirectory()).toBe(true);
			expect(st.mode & 0o777).toBe(0o700);
			expect(() => createSecureDir(base, "run-1")).toThrow();
			expect(() => createSecureDir(base, "../escape")).toThrow();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	test("sockets dir stays inside short run dirs and falls back for long ones", () => {
		const short = resolveSocketsDir("/short/run");
		expect(short.temporary).toBe(false);
		expect(short.dir).toBe("/short/run");
		const long = resolveSocketsDir("/".padEnd(120, "x"));
		expect(long.temporary).toBe(true);
		expect(existsSync(long.dir)).toBe(true);
		expect(statSync(long.dir).mode & 0o777).toBe(0o700);
		rmSync(long.dir, { recursive: true, force: true });
	});
});

describe("owned-launch durable cancel marker", () => {
	test("writes a 0600 single-line marker atomically and idempotently", () => {
		const base = mkdtempSync(join(tmpdir(), "ol-marker-"));
		try {
			const runDir = createSecureDir(base, "run-1");
			const path = writeOwnedLaunchCancelMarker(runDir);
			expect(path).toBe(join(runDir, OWNED_LAUNCH_CANCEL_MARKER));
			const st = statSync(path);
			expect(st.isFile()).toBe(true);
			expect(st.mode & 0o777).toBe(0o600);
			expect(readFileSync(path, "utf8")).toBe("stage=stop\n");
			// The atomic write never leaves temp files behind, and a second
			// write replaces the marker wholesale (stop() is idempotent).
			writeOwnedLaunchCancelMarker(runDir);
			expect(readFileSync(path, "utf8")).toBe("stage=stop\n");
			expect(readdirSync(runDir).filter((name) => name.startsWith(".cancel.tmp"))).toEqual([]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("owned-launch bootstrap fail-closed", () => {
	test("missing toolchain rejects instead of degrading", async () => {
		const cacheRoot = join(tmpdir(), `ol-nocache-${Date.now()}`);
		try {
			await expect(
				ensureOwnedLaunchBinaries({ cacheRoot, env: { PATH: "/nonexistent-ol" } }),
			).rejects.toThrow(/toolchain|xcrun|build failed|spawn/i);
		} finally {
			rmSync(cacheRoot, { recursive: true, force: true });
		}
	});
});

describe("native bootstrap concurrency", () => {
	const darwin = process.platform === "darwin" ? test : test.skip;
	darwin("concurrent first launches share one build; parallel builders and stale leftovers never fail", async () => {
		const { compileOwnedLaunchBinaries, ensureOwnedLaunchBinaries } = await import("../../../src/async-subagents/core/owned-launch/bootstrap.js");
		const { accessSync, constants, mkdtempSync: mkdtemp, rmSync: rm, writeFileSync: write } = await import("node:fs");
		const { tmpdir: tmp } = await import("node:os");
		const { join: j } = await import("node:path");
		const root = mkdtemp(j(tmp(), "ol-bootstrap-"));
		try {
			// Three concurrent cold-cache callers in one process (the live T9 failure).
			const results = await Promise.all([1, 2, 3].map(() => ensureOwnedLaunchBinaries({ cacheRoot: j(root, "cache") })));
			expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
			for (const path of Object.values(results[0])) accessSync(path, constants.X_OK);
			// Two independent builders into one directory (two Pi processes), with a
			// leftover temp artifact from a crashed build already present.
			const shared = j(root, "shared");
			await compileOwnedLaunchBinaries(shared).then(() => undefined);
			write(j(shared, ".owned-launch-bridge.build"), "partial");
			const both = await Promise.all([compileOwnedLaunchBinaries(shared), compileOwnedLaunchBinaries(shared)]);
			for (const bins of both) for (const path of Object.values(bins)) accessSync(path, constants.X_OK);
		} finally {
			rm(root, { recursive: true, force: true });
		}
	}, 180_000);
});
