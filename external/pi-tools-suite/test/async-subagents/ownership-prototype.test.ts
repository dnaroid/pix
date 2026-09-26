import { test, expect } from "bun:test";
import { scenario, state, until, ended, send } from "./ownership-harness.ts";

test.skipIf(process.platform === "win32")("offline owner: fail closed before authorization and on wrong credential", async () => {
	await scenario(async ({ wrapper, authorize }) => {
		const early = wrapper();
		expect(await ended(early.child)).toBe(1);
		expect(early.pid("cli")).toBe(0);
		expect(early.pid("guardian")).toBe(0);
		await authorize();
		const bad = wrapper("wrong credential");
		expect(await ended(bad.child)).toBe(1);
		expect(bad.pid("cli")).toBe(0);
		expect(bad.pid("guardian")).toBe(0);
	});
}, 12000);

test.skipIf(process.platform === "win32")("offline owner: death before authorization fails closed without CLI", async () => {
	await scenario(async ({ owner, wrapper, pid }) => {
		owner.kill("SIGKILL");
		await until(() => !state(owner.pid!).live, "owner exited");
		const attempt = wrapper();
		expect(await ended(attempt.child)).not.toBe(0);
		expect(pid("guardian")).toBe(0);
		expect(pid("cli")).toBe(0);
	});
}, 12000);

test.skipIf(process.platform === "win32")("offline owner: failed guardian authentication prevents CLI", async () => {
	await scenario(async ({ authorize, wrapper }) => {
		await authorize();
		const attempt = wrapper(undefined, "guardian-fail");
		expect(await ended(attempt.child)).not.toBe(0);
		await until(() => attempt.pid("guardian") > 0 && !state(attempt.pid("guardian")).live, "failed guardian exit");
		expect(attempt.pid("cli")).toBe(0);
	});
}, 12000);

test.skipIf(process.platform === "win32")("offline owner: death at unreleased guardian-ready barrier leaves no CLI", async () => {
	await scenario(async ({ owner, authorize, wrapper, pid }) => {
		await authorize();
		const { child, next } = wrapper();
		const ready = await next("guardian-ready");
		owner.kill("SIGKILL");
		await until(() => !state(ready.guardian).live, "guardian cleanup");
		expect(pid("cli")).toBe(0);
		await ended(child);
	});
}, 12000);

test.skipIf(process.platform === "win32")("offline owner: release racing owner death eventually cleans any launched actors", async () => {
	await scenario(async ({ owner, authorize, wrapper }) => {
		await authorize();
		const request = wrapper();
		const ready = await request.next("guardian-ready");
		// Release and owner SIGKILL are unordered; a CLI may start transiently.
		await send(request.child, "launch");
		owner.kill("SIGKILL");
		await until(() => !state(owner.pid!).live && !state(request.child.pid!).live && !state(ready.guardian).live, "owner and request exit");
		await until(() => ["cli-launched", "cli", "leaf"].every((name) => !state(request.pid(name)).live), "racing descendants gone");
	});
}, 12000);

test.skipIf(process.platform === "win32")("offline owner: guardian SIGKILL while active kills owned group, not owner or control", async () => {
	await scenario(async ({ owner, authorize, wrapper, control }) => {
		await authorize();
		const unrelated = control();
		const request = wrapper();
		const ready = await request.next("guardian-ready");
		await send(request.child, "launch");
		const launched = await request.next("cli-launched");
		await until(() => request.pid("leaf") > 0 && state(request.pid("leaf")).live, "resistant leaf live");
		const leaf = request.pid("leaf");
		expect(state(launched.pid).live).toBe(true);
		expect(state(unrelated.pid!).live).toBe(true);
		process.kill(ready.guardian, "SIGKILL");
		await until(() => !state(launched.pid).live && !state(leaf).live && !state(request.child.pid!).live, "wrapper fallback cleanup");
		expect(state(owner.pid!).live).toBe(true);
		expect(state(unrelated.pid!).live).toBe(true);
	});
}, 12000);

test.skipIf(process.platform === "win32")("offline owner: concurrent owner EOF and guardian loss clean active group", async () => {
	await scenario(async ({ owner, authorize, wrapper }) => {
		await authorize();
		const request = wrapper();
		const ready = await request.next("guardian-ready");
		await send(request.child, "launch");
		const launched = await request.next("cli-launched");
		await until(() => request.pid("leaf") > 0 && state(request.pid("leaf")).live, "leaf live before concurrent loss");
		const leaf = request.pid("leaf");
		process.kill(ready.guardian, "SIGKILL");
		owner.kill("SIGKILL");
		await until(() => !state(owner.pid!).live && !state(request.child.pid!).live && !state(launched.pid).live && !state(leaf).live, "both error paths teardown");
	});
}, 12000);

test.skipIf(process.platform === "win32")("offline owner: SIGKILL while active cleans resistant descendants", async () => {
	await scenario(async ({ owner, authorize, wrapper, pid }) => {
		await authorize();
		const { child, next } = wrapper();
		const ready = await next("guardian-ready");
		await send(child, "launch");
		await next("cli-launched");
		await until(() => pid("leaf") > 0, "leaf started");
		const leaf = pid("leaf");
		expect(state(leaf).live).toBe(true);
		owner.kill("SIGKILL");
		await until(() => !state(leaf).live && !state(ready.guardian).live, "owner EOF cleanup");
	});
}, 12000);

for (const [completion, code] of [["complete", 0], ["complete-fail", 7]] as const) {
	test.skipIf(process.platform === "win32")(`offline owner: CLI ${code} propagates and cleans survivor`, async () => {
		await scenario(async ({ authorize, wrapper }) => {
			await authorize();
			const request = wrapper(undefined, "success");
			const ready = await request.next("guardian-ready");
			await send(request.child, "launch");
			const launched = await request.next("cli-launched");
			await until(() => request.pid("leaf") > 0 && state(request.pid("leaf")).live, "live leaf before completion");
			const leaf = request.pid("leaf");
			expect(state(launched.pid).live).toBe(true);
			await send(request.child, completion);
			expect(await ended(request.child)).toBe(code);
			await until(() => !state(leaf).live && !state(ready.guardian).live, "wrapper EOF cleanup");
		});
	}, 12000);
}

test.skipIf(process.platform === "win32")("offline owner: provider-style negative wrapper PGID SIGTERM cleans resistant CLI", async () => {
	await scenario(async ({ authorize, wrapper, pid }) => {
		await authorize();
		const { child, next } = wrapper();
		await next("guardian-ready");
		await send(child, "launch");
		await next("cli-launched");
		await until(() => pid("leaf") > 0, "leaf started");
		expect(state(pid("guardian")).pgid).toBe(child.pid);
		process.kill(-child.pid!, "SIGTERM");
		await until(() => !state(pid("leaf")).live && !state(pid("guardian")).live, "group stopped");
	});
}, 12000);

test.skipIf(process.platform === "win32")("offline owner: cancel one of two groups leaves other and unrelated control running", async () => {
	await scenario(async ({ authorize, wrapper, control }) => {
		await authorize();
		const unrelated = control();
		const a = wrapper();
		const b = wrapper();
		await Promise.all([a.next("guardian-ready"), b.next("guardian-ready")]);
		await Promise.all([send(a.child, "launch"), send(b.child, "launch")]);
		await Promise.all([a.next("cli-launched"), b.next("cli-launched")]);
		await until(() => a.pid("leaf") > 0 && b.pid("leaf") > 0 && state(unrelated.pid!).live, "both leaves and control");
		expect(state(a.pid("guardian")).pgid).toBe(a.child.pid);
		expect(state(b.pid("guardian")).pgid).toBe(b.child.pid);
		expect(state(unrelated.pid!).pgid).toBe(unrelated.pid);
		process.kill(-a.child.pid!, "SIGTERM");
		await until(() => !state(a.pid("leaf")).live && !state(a.pid("guardian")).live, "first group cleanup");
		expect(state(b.pid("leaf")).live).toBe(true);
		expect(state(b.pid("guardian")).live).toBe(true);
		expect(state(unrelated.pid!).live).toBe(true);
	});
}, 12000);
