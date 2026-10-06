import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { lock } from "proper-lockfile";
import { withRegistryCache } from "../src/registry/cache-lock.js";
import { registryUiCacheRoot } from "../src/registry/config.js";

const moduleUrl = new URL("../src/registry/cache-lock.ts", import.meta.url).href;
const configUrl = new URL("../src/registry/config.ts", import.meta.url).href;
const artifacts = fileURLToPath(new URL("../../.pi/artifacts/", import.meta.url));
const children: ChildProcess[] = [];
let root: string;
let originalCacheHome: string | undefined;

beforeEach(async () => {
	originalCacheHome = process.env.XDG_CACHE_HOME;
	await fs.mkdir(artifacts, { recursive: true });
	root = await fs.mkdtemp(join(artifacts, "registry-cache-test-"));
	process.env.XDG_CACHE_HOME = root;
});

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
	}
	if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = originalCacheHome;
	await fs.rm(root, { recursive: true, force: true });
});

function worker(body: string): { child: ChildProcess; waitFor: (message: string) => Promise<void> } {
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
		import { promises as fs } from "node:fs";
		import { withRegistryCache } from ${JSON.stringify(moduleUrl)};
		import { registryUiCacheRoot } from ${JSON.stringify(configUrl)};
		${body}
		process.disconnect();
	`], {
		cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
		env: { ...process.env },
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	children.push(child);
	const seen = new Set<string>();
	const waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
	let failure: Error | undefined;
	let stderr = "";
	child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
	child.on("message", (message) => {
		const name = String(message);
		seen.add(name);
		waiters.get(name)?.resolve();
		waiters.delete(name);
	});
	function fail(error: Error): void {
		failure = error;
		for (const waiter of waiters.values()) waiter.reject(error);
		waiters.clear();
	}
	child.on("error", fail);
	child.on("exit", (code, signal) => fail(new Error(`Worker exited (${code ?? signal}): ${stderr}`)));
	return {
		child,
		waitFor(message) {
			if (seen.has(message)) return Promise.resolve();
			if (failure) return Promise.reject(failure);
			return new Promise<void>((resolve, reject) => { waiters.set(message, { resolve, reject }); });
		},
	};
}

test("cache path and checkout contents are reused across ACP processes", { timeout: 15_000 }, async () => {
	const first = worker(`
		await withRegistryCache(async () => {
			await fs.mkdir(registryUiCacheRoot(), { recursive: true });
			await fs.writeFile(registryUiCacheRoot() + "/marker", "reused");
		});
		process.send("done");
	`);
	await first.waitFor("done");
	const second = worker(`
		await withRegistryCache(async () => {
			if (await fs.readFile(registryUiCacheRoot() + "/marker", "utf8") !== "reused") throw Error("Not reused");
		});
		process.send("done");
	`);
	await second.waitFor("done");
	assert.equal(registryUiCacheRoot(), join(root, "pi", "resource-registry-desktop"));
	assert.deepEqual(await fs.readdir(join(root, "pi")), ["resource-registry-desktop"]);
});

test("cross-process lock survives checkout replacement and releases before the next owner", { timeout: 15_000 }, async () => {
	const first = worker(`
		await withRegistryCache(async () => {
			await fs.mkdir(registryUiCacheRoot(), { recursive: true });
			await fs.rm(registryUiCacheRoot(), { recursive: true });
			process.send("held");
			await new Promise(resolve => process.once("message", resolve));
			await fs.mkdir(registryUiCacheRoot());
			await fs.writeFile(registryUiCacheRoot() + "/marker", "first completed");
		});
		process.send("done");
	`);
	await first.waitFor("held");
	await assert.rejects(lock(registryUiCacheRoot(), { realpath: false }), { code: "ELOCKED" });
	const next = withRegistryCache(async () => {
		assert.equal(await fs.readFile(join(registryUiCacheRoot(), "marker"), "utf8"), "first completed");
	});
	first.child.send("release");
	await next;
	await first.waitFor("done");
	assert.equal(await fs.stat(`${registryUiCacheRoot()}.lock`).catch(() => undefined), undefined);
});

test("failed operations release the filesystem lock and preserve the local queue", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const order: string[] = [];
	const failure = withRegistryCache(async () => {
		order.push("first");
		await held;
		throw new Error("action failed");
	});
	const rejected = assert.rejects(failure, /action failed/);
	const second = withRegistryCache(async () => { order.push("second"); return 42; });
	release();
	await rejected;
	assert.equal(await second, 42);
	assert.deepEqual(order, ["first", "second"]);
	const releaseLock = await lock(registryUiCacheRoot(), { realpath: false });
	await releaseLock();
});

test("a stale crashed-owner lock is reclaimed without requiring a checkout", async () => {
	const key = registryUiCacheRoot();
	await fs.mkdir(`${key}.lock`, { recursive: true });
	const stale = new Date(Date.now() - 180_000);
	await fs.utimes(`${key}.lock`, stale, stale);
	assert.equal(await withRegistryCache(async () => "recovered"), "recovered");
	assert.equal(await fs.stat(`${key}.lock`).catch(() => undefined), undefined);
});
