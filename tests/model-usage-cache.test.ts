import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ModelUsageCache } from "../src/app/model/model-usage-cache.js";
import { modelUsageCacheIdentity, modelUsageDescriptor, type ModelUsageStatus } from "../src/app/model/model-usage-status.js";
import { modelUsageAuthPath, withModelUsageAuthScope } from "../src/app/model/model-usage-auth-scope.js";
import { selectClaudeCodeUsageIdentity } from "../src/app/model/claude-code-usage-auth.js";

const model = { provider: "openai-codex", id: "gpt" };
const other = { provider: "anthropic", id: "claude" };
const quota = (ref = "openai-codex/gpt"): ModelUsageStatus => ({
	modelKey: ref, provider: ref.startsWith("anthropic") ? "anthropic" : "openai", updatedAt: Date.now(), accountEmail: "a@example.test",
	hourly: { remainingPercent: 45, resetAt: Date.now() + 3_600_000, windowSeconds: 18_000 },
});

describe("global account-scoped quota cache", () => {
	let directory: string;
	let account: string | undefined;
	let cache: ModelUsageCache;
	let savedEnv: Record<string, string | undefined>;
	beforeEach(async () => {
		await mkdir(".pi/artifacts", { recursive: true });
		directory = await mkdtemp(".pi/artifacts/model-usage-cache-test-");
		account = "secret-refresh-token-account-a";
		savedEnv = Object.fromEntries(["NODE_ENV", "PI_TOOLS_SUITE_TEST_AUTH_PATH", "PI_TOOLS_SUITE_TEST_OPENCODE_AUTH_PATH", "CLAUDE_CONFIG_DIR"].map((key) => [key, process.env[key]]));
		process.env.NODE_ENV = "test";
		delete process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
		delete process.env.PI_TOOLS_SUITE_TEST_OPENCODE_AUTH_PATH;
		cache = new ModelUsageCache({ agentDir: directory, identity: async () => account });
	});
	afterEach(async () => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await rm(directory, { recursive: true, force: true });
	});

	it("hydrates stale quotas in another instance, with no provider fetch and no credentials in files", async () => {
		let fetches = 0;
		await cache.query(model, async () => { fetches++; return { refresh: "ready", status: quota() }; });
		const restarted = new ModelUsageCache({ agentDir: directory, identity: async () => account });
		const saved = await restarted.read([model]);
		assert.equal(saved.snapshots[0]?.stale, true);
		assert.equal(saved.snapshots[0]?.hourly?.remainingPercent, 45);
		assert.equal(saved.routeScopes[model.provider], (await restarted.query(model, async () => ({ refresh: "unavailable" }))).cacheScope);
		assert.equal(fetches, 1);
		const path = join(directory, "cache", "usage", "v1", "quotas");
		const names = await readdir(path);
		assert.equal(names.length, 1);
		assert.match(names[0]!, /^[a-f0-9]{64}\.json$/);
		const file = join(path, names[0]!);
		assert.ok(!(await readFile(file, "utf8")).includes(account!));
		if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600); // POSIX privacy bits; Windows uses ACLs.
	});

	it("isolates accounts and profiles, and never reads cache data without a credential identity", async () => {
		await cache.query(model, async () => ({ refresh: "ready", status: quota() }));
		const first = await cache.read([model]);
		account = "different-account";
		const second = await cache.read([model]);
		assert.notEqual(first.scope, second.scope);
		assert.equal(second.snapshots.length, 0);
		account = "secret-refresh-token-account-a";
		const profile = new ModelUsageCache({ agentDir: join(directory, "other-profile"), identity: async () => account });
		assert.equal((await profile.read([model])).snapshots.length, 0);
		assert.notEqual((await profile.read([model])).scope, first.scope);
		account = undefined;
		assert.equal((await cache.read([model])).snapshots.length, 0);
		account = "secret-refresh-token-account-a";
		assert.equal((await cache.read([model])).snapshots.length, 1);
	});

	it("discards a completion and does not write when the login changes during fetch", async () => {
		let finish!: (value: { refresh: "ready"; status: ModelUsageStatus }) => void;
		let started!: () => void;
		const inFlight = new Promise<void>((resolve) => { started = resolve; });
		const pending = cache.query(model, () => new Promise((resolve) => { finish = resolve; started(); }));
		await inFlight;
		account = "new-account";
		finish({ refresh: "ready", status: quota() });
		assert.deepEqual(await pending, { refresh: "unavailable", cacheInvalidated: true });
		account = "secret-refresh-token-account-a";
		assert.equal((await cache.read([model])).snapshots.length, 0);
	});

	it("keeps independent entries written concurrently by different processes' cache owners", async () => {
		const writer = new ModelUsageCache({ agentDir: directory, identity: async () => account });
		await Promise.all([
			cache.query(model, async () => ({ refresh: "ready", status: quota() })),
			writer.query(other, async () => ({ refresh: "ready", status: quota("anthropic/claude") })),
		]);
		assert.deepEqual((await cache.read([model, other])).snapshots.map((value) => value.modelKey).sort(), ["anthropic/claude", "openai-codex/gpt"]);
	});

	it("bounds account rotations to one quota file per model", async () => {
		for (let index = 0; index < 5; index++) {
			account = `account-${index}`;
			await cache.query(model, async () => ({ refresh: "ready", status: quota() }));
		}
		assert.equal((await readdir(join(directory, "cache", "usage", "v1", "quotas"))).length, 1);
		account = "account-0";
		assert.equal((await cache.read([model])).snapshots.length, 0);
	});

	it("keeps a known OpenAI account stable through refresh-token rotation during fetch", async () => {
		const authPath = join(directory, "auth.json");
		const jwt = (id: string, user: string) => `header.${Buffer.from(JSON.stringify({ sub: user, "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.signature`;
		const login = (id: string, refresh: string, user = "member-a") => JSON.stringify({ "openai-codex": { type: "oauth", access: jwt(id, user), refresh, expires: 1 } });
		await writeFile(authPath, login("account-a", "refresh-one"));
		const real = new ModelUsageCache({ agentDir: directory });
		const before = await real.read([model]);
		const result = await real.query(model, async () => {
			await writeFile(authPath, login("account-a", "refresh-two"));
			return { refresh: "ready", status: quota() };
		});
		assert.equal(result.refresh, "ready");
		assert.equal(result.cacheScope, before.routeScopes[model.provider]);
		await writeFile(authPath, login("account-a", "refresh-two", "member-b"));
		assert.equal((await real.read([model])).snapshots.length, 0); // Team workspace id alone is not a user identity.
		await writeFile(authPath, login("account-b", "refresh-two"));
		assert.equal((await real.read([model])).snapshots.length, 0);
	});

	it("does not save failures, partial/stale quotas, credits or expired windows", async () => {
		await cache.query(model, async () => ({ refresh: "failed" }));
		await cache.query(model, async () => ({ refresh: "ready", status: { ...quota(), stale: true } }));
		assert.equal((await cache.read([model])).snapshots.length, 0);
		await cache.query(model, async () => ({ refresh: "ready", status: { ...quota(), resetCreditsAvailableCount: 3, resetCredits: [{ title: "Full reset", count: 3 }] } }));
		assert.equal((await cache.read([model])).snapshots[0]?.resetCredits, undefined);
		await cache.query(model, async () => ({ refresh: "ready", status: { ...quota(), hourly: { ...quota().hourly!, resetAt: Date.now() - 1 } } }));
		assert.equal((await cache.read([model])).snapshots.length, 0);
	});

	it("ignores corrupt/unknown-version files and logs sanitized errors once", async () => {
		const events: string[] = [];
		cache = new ModelUsageCache({ agentDir: directory, identity: async () => account, log: (_level, event, details) => events.push(`${event}:${JSON.stringify(details)}`) });
		await cache.query(model, async () => ({ refresh: "ready", status: quota() }));
		const folder = join(directory, "cache", "usage", "v1", "quotas");
		const file = join(folder, (await readdir(folder))[0]!);
		const saved = JSON.parse(await readFile(file, "utf8")).data;
		for (const raw of ["secret cache payload", JSON.stringify({ version: 2, data: saved }), JSON.stringify({ version: 1, data: { ...saved, quota: { ...quota(), hourly: { resetAt: 1 } } } }), JSON.stringify({ version: 1, data: { ...saved, quota: { ...quota(), hourly: { ...quota().hourly, resetAtEstimated: "invalid" } } } })]) {
			await writeFile(file, raw);
			assert.equal((await cache.read([model])).snapshots.length, 0);
		}
		assert.equal(events.length, 1);
		assert.ok(!events[0]?.includes("secret"));
	});

	it("does not let disk failures or a throwing logger suppress fresh quotas", async () => {
		await writeFile(join(directory, "cache"), "not a directory");
		cache = new ModelUsageCache({ agentDir: directory, identity: async () => account, log: () => { throw new Error("logger"); } });
		assert.equal((await cache.query(model, async () => ({ refresh: "ready", status: quota() }))).refresh, "ready");
		assert.equal((await cache.read([model])).snapshots.length, 0);
	});

	it("resolves expired OAuth identities locally and changes scope for keys and Antigravity account sets", async () => {
		const authPath = join(directory, "auth.json");
		const descriptor = modelUsageDescriptor(model)!;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => { throw new Error("identity resolution must not use the network"); };
		try {
			await writeFile(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: "expired-access", refresh: "refresh-a", expires: 1 } }));
			const identity = () => withModelUsageAuthScope(directory, () => modelUsageCacheIdentity(descriptor));
			const first = await identity();
			assert.match(first!, /^[a-f0-9]{64}$/);
			await writeFile(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: "rotated-access", refresh: "refresh-a", expires: 2 } }));
			assert.equal(await identity(), first, "access-token refresh does not invalidate the same account");
			await writeFile(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: "rotated-access", refresh: "refresh-b", expires: 2 } }));
			assert.notEqual(await identity(), first);
			await writeFile(authPath, "{}");
			assert.equal(await identity(), undefined);
			const anthropic = modelUsageDescriptor(other)!;
			await writeFile(authPath, JSON.stringify({ anthropic: { type: "oauth", refresh: "expired-with-no-access" } }));
			assert.ok(await withModelUsageAuthScope(directory, () => modelUsageCacheIdentity(anthropic)));
			const google = modelUsageDescriptor({ provider: "google-antigravity", id: "gemini-3.1-pro-high" })!;
			const auth = { type: "oauth", email: "same-fallback-email", accounts: [{ refreshToken: "one", enabled: true }, { refreshToken: "two", enabled: true }] };
			await writeFile(authPath, JSON.stringify({ "google-antigravity": auth }));
			const all = await withModelUsageAuthScope(directory, () => modelUsageCacheIdentity(google));
			auth.accounts[0]!.enabled = false;
			await writeFile(authPath, JSON.stringify({ "google-antigravity": auth }));
			assert.notEqual(await withModelUsageAuthScope(directory, () => modelUsageCacheIdentity(google)), all);
			const zai = modelUsageDescriptor({ provider: "zai", id: "glm" })!;
			await writeFile(authPath, JSON.stringify({ zai: { type: "api_key", key: "one" } }));
			const key = await withModelUsageAuthScope(directory, () => modelUsageCacheIdentity(zai));
			await writeFile(authPath, JSON.stringify({ zai: { type: "api_key", key: "two" } }));
			assert.notEqual(await withModelUsageAuthScope(directory, () => modelUsageCacheIdentity(zai)), key);
		} finally { globalThis.fetch = originalFetch; }
	});

	it("keeps concurrent profile scopes separate across awaits", async () => {
		const profiles = [directory, join(directory, "other")];
		const paths = await Promise.all(profiles.map((profile) => withModelUsageAuthScope(profile, async () => {
			await new Promise((resolve) => setImmediate(resolve));
			return modelUsageAuthPath();
		})));
		assert.deepEqual(paths, profiles.map((profile) => join(profile, "auth.json")));
	});

	it("uses Claude's selected credential, survives token expiry/rotation and fails closed on ambiguous expired accounts", async () => {
		const raw = (refreshToken: string, accessToken: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { refreshToken, accessToken, expiresAt } });
		const future = Date.now() + 60_000;
		const active = raw("refresh-a", "sk-ant-oat-one", future);
		const first = await selectClaudeCodeUsageIdentity(async () => active, async () => undefined);
		assert.equal(await selectClaudeCodeUsageIdentity(undefined, async () => raw("refresh-a", "sk-ant-oat-rotated", 1)), first);
		const fallback = raw("refresh-b", "sk-ant-oat-other", future);
		assert.equal(await selectClaudeCodeUsageIdentity(async () => raw("refresh-a", "sk-ant-oat-one", 1), async () => fallback), await selectClaudeCodeUsageIdentity(undefined, async () => fallback));
		assert.equal(await selectClaudeCodeUsageIdentity(async () => raw("refresh-a", "sk-ant-oat-one", 1), async () => raw("refresh-b", "sk-ant-oat-other", 1)), undefined);
		process.env.CLAUDE_CONFIG_DIR = "/different-profile";
		assert.notEqual(await selectClaudeCodeUsageIdentity(undefined, async () => active), first);
	});
});
