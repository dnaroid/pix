import { test, expect } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Native macOS-only OS experiment. Every case has its own binary and PID files;
// no installed provider, network, Pi process, or external ancestry snapshot.
const source = fileURLToPath(new URL("./fixtures/native-ownership.c", import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function value(dir: string, name: string): number {
	const path = join(dir, name);
	return existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
}
function status(pid: number): { group: number; stat: string } {
	if (!pid) return { group: 0, stat: "" };
	try {
		const [group, stat] = execFileSync("ps", ["-o", "pgid=,stat=", "-p", String(pid)], { timeout: 800 }).toString().trim().split(/\s+/);
		return { group: Number(group), stat: stat ?? "" };
	} catch (error) {
		const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
		if (e.status === 1 && !e.stdout?.length && !e.stderr?.length) return { group: 0, stat: "" };
		throw error;
	}
}
function live(pid: number): boolean {
	const observed = status(pid);
	return !!observed.stat && !observed.stat.startsWith("Z");
}
async function until(check: () => boolean, label: string) {
	const deadline = Date.now() + 4000;
	while (Date.now() < deadline) {
		if (check()) return;
		await sleep(20);
	}
	throw new Error(`timeout: ${label}`);
}
const signal = (pid: number, sig: NodeJS.Signals) => {
	try { process.kill(pid, sig); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
};
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} not reaped`)), 4000);
		})]);
	} finally { if (timer) clearTimeout(timer); }
}

async function scenario(code: number, mode: "normal" | "race" | "startup", run: (ctx: {
	dir: string; a: ChildProcess; b: number; c: number; leaf: number;
	finish: () => Promise<number | null>;
}) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "native-ownership-"));
	let a: ChildProcess | undefined;
	let control: ChildProcess | undefined;
	let controlExit: Promise<number | null> | undefined;
	let b = 0;
	let c = 0;
	let leaf = 0;
	let childExit: Promise<number | null> | undefined;
	let failure: unknown;
	const cleanupErrors: unknown[] = [];
	try {
		control = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
		const unrelated = control;
		controlExit = new Promise((resolve, reject) => {
			unrelated.once("error", reject);
			unrelated.once("exit", resolve);
		});
		await until(() => status(unrelated.pid!).group === unrelated.pid, "unrelated control group");
		const binary = join(dir, "relay");
		execFileSync("cc", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-o", binary, source], { timeout: 5000 });
		a = spawn(binary, [dir, String(code), mode], { stdio: "ignore" });
		const child = a;
		childExit = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (exit) => resolve(exit));
		});
		await until(() => (mode === "startup"
			? value(dir, "pre_ready_checkpoint") > 0 && status(child.pid!).stat.startsWith("T")
			: value(dir, "ready") > 0) && value(dir, "cli") > 0 && value(dir, "leaf") > 0, "A/B/C/D topology");
		b = mode === "startup" ? value(dir, "pre_ready_checkpoint") : value(dir, "ready");
		leaf = value(dir, "leaf");
		c = value(dir, "cli");
		expect(value(dir, "a")).toBe(child.pid!);
		expect(value(dir, "b")).toBe(b);
		expect(status(child.pid!).group).not.toBe(b);
		for (const pid of [b, c, leaf]) {
			expect(status(pid).group).toBe(b);
			expect(live(pid)).toBe(true);
		}
		await run({ dir, a: child, b, c, leaf, finish: () => bounded(childExit!, "A") });
		expect(live(unrelated.pid!)).toBe(true);
	} catch (error) { failure = error; }
	finally {
		const attempt = (action: () => void) => { try { action(); } catch (error) { cleanupErrors.push(error); } };
		const refresh = () => {
			attempt(() => { b ||= value(dir, "ready") || value(dir, "pre_ready_checkpoint") || value(dir, "b"); });
			attempt(() => { c ||= value(dir, "cli"); });
			attempt(() => { leaf ||= value(dir, "leaf"); });
		};
		const groupBackstop = () => attempt(() => {
			// Fixture-only residual non-atomic ps check, NOT production ownership
			// proof or a reusable process killer. A's unreaped child anchor is A's,
			// not ours; require recorded ownership and a live group member.
			if (!b || !a?.pid || status(a.pid).group === b) return;
			if ([b, c, leaf].some((pid) => {
				try {
					const observed = status(pid);
					return observed.group === b && !!observed.stat && !observed.stat.startsWith("Z");
				} catch (error) { cleanupErrors.push(error); return false; }
			})) signal(-b, "SIGKILL");
		});
		// Release checkpoints first; errors in any step cannot suppress later
		// teardown, child reaping, checks, or removal of the temporary directory.
		attempt(() => { if (a?.pid && status(a.pid).stat.startsWith("T")) signal(a.pid, "SIGCONT"); });
		refresh();
		groupBackstop();
		attempt(() => { if (a?.pid && live(a.pid)) signal(a.pid, "SIGKILL"); });
		attempt(() => {
			if (!control?.pid) return;
			const observed = status(control.pid);
			if (observed.stat && !observed.stat.startsWith("Z"))
				signal(observed.group === control.pid ? -control.pid : control.pid, "SIGKILL");
		});
		if (childExit) try { await bounded(childExit, "A"); } catch (error) { cleanupErrors.push(error); }
		if (controlExit) try { await bounded(controlExit, "control"); } catch (error) { cleanupErrors.push(error); }
		refresh(); // capture any actor recorded during a startup failure
		groupBackstop();
		for (const [name, pid] of [["B", b], ["C", c], ["leaf", leaf]] as const) {
			if (!pid) continue;
			try { await until(() => !live(pid), `${name} cleanup`); }
			catch (error) { cleanupErrors.push(error); }
		}
		attempt(() => rmSync(dir, { recursive: true, force: true }));
	}
	if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "native fixture or cleanup failed");
}

for (const code of [0, 7]) {
	test.skipIf(process.platform !== "darwin")(`native relay C actual ${code}: group cleanup before B reap`, async () => {
		await scenario(code, "normal", async ({ dir, a, b, leaf, finish }) => {
			writeFileSync(join(dir, "complete"), "go");
			expect(await finish()).toBe(code);
			expect(value(dir, "b_reaped")).toBe(1);
			expect(live(b)).toBe(false);
			expect(live(leaf)).toBe(false);
			expect(live(a.pid!)).toBe(false);
		});
	}, 15000);
	test.skipIf(process.platform !== "darwin")(`native relay C actual ${code}: dead B remains waitable through checkpoint`, async () => {
		await scenario(code, "race", async ({ dir, a, b, c, leaf, finish }) => {
			writeFileSync(join(dir, "complete"), "go");
			await until(() => existsSync(join(dir, "checkpoint")) && value(dir, "checkpoint") === code && status(a.pid!).stat.startsWith("T"), "kernel-stopped A after C status");
			expect(live(c)).toBe(false);
			expect(live(leaf)).toBe(true);
			expect(live(b)).toBe(true);
			signal(b, "SIGKILL");
			await until(() => status(b).stat.startsWith("Z"), "B zombie while A stopped");
			expect(live(leaf)).toBe(true);
			signal(a.pid!, "SIGCONT");
			expect(await finish()).toBe(code);
			expect(value(dir, "zombie_wnowait")).toBe(9); // SIGKILL from waitid before reap
			expect(value(dir, "b_reaped")).toBe(1);
			expect(live(leaf)).toBe(false);
		});
	}, 15000);
}

test.skipIf(process.platform !== "darwin")("native relay A SIGKILL: private EOF triggers B self-group cleanup", async () => {
	await scenario(0, "normal", async ({ dir, a, b, leaf, finish }) => {
		signal(a.pid!, "SIGKILL");
		expect(await finish()).toBe(null);
		await until(() => value(dir, "b_eof") === 1 && !live(leaf), "B EOF and leaf dead");
		expect(live(b)).toBe(false);
	});
}, 15000);

test.skipIf(process.platform !== "darwin")("native relay B lost before C status: fail closed, not fabricated zero", async () => {
	await scenario(0, "normal", async ({ dir, b, leaf, finish }) => {
		signal(b, "SIGKILL");
		expect(await finish()).toBe(90);
		expect(value(dir, "b_reaped")).toBe(1);
		expect(live(leaf)).toBe(false);
	});
}, 15000);

test.skipIf(process.platform !== "darwin")("native relay B zombie before A verifies group: fail closed and kill group before reap", async () => {
	await scenario(0, "startup", async ({ dir, a, b, c, leaf, finish }) => {
		expect(value(dir, "ready")).toBe(0);
		expect(status(a.pid!).stat.startsWith("T")).toBe(true);
		expect(live(c)).toBe(true);
		expect(live(leaf)).toBe(true);
		signal(b, "SIGKILL");
		await until(() => status(b).stat.startsWith("Z"), "B zombie before startup verification");
		expect(live(leaf)).toBe(true);
		signal(a.pid!, "SIGCONT");
		const result = await finish();
		expect(result).toBe(98); // the startup failure path, not a fabricated C result
		expect(value(dir, "ready")).toBe(0);
		expect(value(dir, "b_reaped")).toBe(1);
		expect(live(leaf)).toBe(false); // observed before harness finally/backstop
		expect(live(c)).toBe(false);
	});
}, 15000);
