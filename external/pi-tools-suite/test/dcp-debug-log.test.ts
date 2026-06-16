import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/dcp/config.js";
import {
	dcpDebugLogDrain,
	dcpDebugLogMaxBackups,
	dcpDebugLogMaxBytes,
	writeDcpDebugLog,
} from "../src/dcp/debug-log.js";

function tempDir(prefix = "pi-tools-suite-dcp-debug-log-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function makeConfig(debugLog: { maxBytes?: number; maxBackups?: number }) {
	const config = loadConfig({ homeDir: tempDir() });
	config.debug = true;
	config.debugLog = debugLog;
	return config;
}

const ENV_KEYS = [
	"PI_DCP_DEBUG",
	"PI_TOOLS_SUITE_DCP_DEBUG",
	"PI_DCP_DEBUG_LOG",
	"PI_DCP_DEBUG_MAX_BYTES",
	"PI_DCP_DEBUG_MAX_BACKUPS",
] as const;

function withCleanEnv<T>(fn: () => Promise<T> | T): Promise<T> {
	const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
	for (const key of ENV_KEYS) delete process.env[key];
	// Restore only after the (possibly async) body settles, so env stays clean
	// for any path/limit reads performed after awaits inside the body.
	return Promise.resolve(fn()).finally(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

describe("DCP debug log", () => {
	test("rotates the active file when it reaches maxBytes and keeps maxBackups copies", async () => {
		await withCleanEnv(async () => {
			const dir = tempDir();
			const logPath = join(dir, "dcp-debug.jsonl");
			process.env.PI_DCP_DEBUG_LOG = logPath;

			const config = makeConfig({ maxBytes: 300, maxBackups: 2 });

			// Each line is well under maxBytes, so rotation triggers periodically.
			for (let i = 0; i < 80; i++) {
				writeDcpDebugLog(config, "test.event", { index: i, payload: "x".repeat(60) });
			}
			await dcpDebugLogDrain();

			const names = new Set(readdirSync(dir));
			expect(names.has("dcp-debug.jsonl.1")).toBe(true);
			expect(names.has("dcp-debug.jsonl.2")).toBe(true);
			// maxBackups=2 means only .1 and .2 are retained; .3 must be dropped.
			expect(names.has("dcp-debug.jsonl.3")).toBe(false);
			// Active file is bounded: it never grows far past maxBytes.
			expect(statSync(logPath).size).toBeLessThan(300 + 512);
		});
	});

	test("backups contain prior log content and the active file stays appendable", async () => {
		await withCleanEnv(async () => {
			const dir = tempDir();
			const logPath = join(dir, "dcp-debug.jsonl");
			process.env.PI_DCP_DEBUG_LOG = logPath;

			const config = makeConfig({ maxBytes: 200, maxBackups: 1 });

			for (let i = 0; i < 40; i++) {
				writeDcpDebugLog(config, "test.event", { index: i });
			}
			await dcpDebugLogDrain();

			const backup = readFileSync(join(dir, "dcp-debug.jsonl.1"), "utf8");
			expect(backup.trim().split("\n").length).toBeGreaterThan(0);

			// A further write still appends to the active file after draining.
			writeDcpDebugLog(config, "test.event", { index: 999 });
			await dcpDebugLogDrain();
			const active = readFileSync(logPath, "utf8");
			expect(active).toContain('"index":999');
		});
	});

	test("resolves limits from config then env, and floors maxBackups at 1", () => {
		withCleanEnv(() => {
			// Config values win over built-in defaults.
			const base = makeConfig({ maxBytes: 1234, maxBackups: 4 });
			expect(dcpDebugLogMaxBytes(base)).toBe(1234);
			expect(dcpDebugLogMaxBackups(base)).toBe(4);

			// Missing config falls back to built-in defaults.
			const small = makeConfig({});
			expect(dcpDebugLogMaxBytes(small)).toBe(5 * 1024 * 1024);
			expect(dcpDebugLogMaxBackups(small)).toBe(3);

			// Env overrides take precedence over config.
			process.env.PI_DCP_DEBUG_MAX_BYTES = "999";
			process.env.PI_DCP_DEBUG_MAX_BACKUPS = "9";
			expect(dcpDebugLogMaxBytes(base)).toBe(999);
			expect(dcpDebugLogMaxBackups(base)).toBe(9);

			// Invalid env values fall back to config/defaults.
			process.env.PI_DCP_DEBUG_MAX_BYTES = "not-a-number";
			expect(dcpDebugLogMaxBytes(base)).toBe(1234);
		});

		// With no env, a config maxBackups below the floor is clamped to 1.
		withCleanEnv(() => {
			const underfloor = makeConfig({ maxBackups: 0 });
			expect(dcpDebugLogMaxBackups(underfloor)).toBe(1);
		});
	});

	test("writes nothing when debug is disabled", async () => {
		await withCleanEnv(async () => {
			const dir = tempDir();
			const logPath = join(dir, "dcp-debug.jsonl");
			process.env.PI_DCP_DEBUG_LOG = logPath;

			const config = loadConfig({ homeDir: tempDir() });
			config.debug = false;

			writeDcpDebugLog(config, "test.event", { index: 1 });
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(existsSync(logPath)).toBe(false);
		});
	});
});
