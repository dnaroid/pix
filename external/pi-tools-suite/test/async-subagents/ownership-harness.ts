// Offline fixture orchestration and bounded cleanup; never an acceptance harness for Pi/provider.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const fixture = (role: string) => fileURLToPath(new URL(`./fixtures/ownership-${role}.mjs`, import.meta.url));
const node = process.platform === "win32" ? "" : JSON.parse(execFileSync("node", ["-e", "process.stdout.write(JSON.stringify({path:process.execPath,node:process.release.name,bun:!!process.versions.bun}))"], { timeout: 2000 }).toString());
if (process.platform !== "win32" && (node.node !== "node" || node.bun)) throw new Error("real Node required");
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function state(pid: number): { pgid: number; live: boolean } {
	if (!pid) return { pgid: 0, live: false };
	try {
		const text = execFileSync("ps", ["-o", "pgid=,stat=", "-p", String(pid)], { timeout: 700 }).toString().trim();
		const [pgid, stat] = text.split(/\s+/);
		return { pgid: Number(pgid), live: !!stat && !stat.startsWith("Z") };
	} catch (error) {
		const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
		if (failure.status === 1 && !failure.stdout?.length && !failure.stderr?.length) return { pgid: 0, live: false };
		throw error;
	}
}
// A test-only scheduler barrier must observe kernel stopped state, not merely
// the marker written immediately before SIGSTOP.
export function stopped(pid: number): boolean {
	if (!pid) return false;
	try {
		const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { timeout: 700 }).toString().trim();
		return stat.startsWith("T");
	} catch (error) {
		const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
		if (failure.status === 1 && !failure.stdout?.length && !failure.stderr?.length) return false;
		throw error;
	}
}
export async function until(check: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 150; i++) {
		if (check()) return;
		await delay(20);
	}
	throw new Error(`timeout: ${label}`);
}

type Outcome = { code: number | null; error?: Error };
const outcomes = new WeakMap<ChildProcess, Promise<Outcome>>();
const settled = new WeakMap<ChildProcess, Outcome>();
function tracked(child: ChildProcess): ChildProcess {
	outcomes.set(child, new Promise((resolve) => {
		child.once("error", (error) => { const result = { code: null, error }; settled.set(child, result); resolve(result); });
		child.once("exit", (code) => { const result = { code }; settled.set(child, result); resolve(result); });
	}));
	return child;
}
export async function ended(child: ChildProcess): Promise<number | null> {
	const outcome = await outcomes.get(child)!;
	if (outcome.error) throw outcome.error;
	return outcome.code;
}
export function messages(child: ChildProcess): (stage: string) => Promise<any> {
	const queue: any[] = [];
	let pending: ((value: any) => void) | undefined;
	child.on("message", (value) => { if (pending) { const receive = pending; pending = undefined; receive(value); } else queue.push(value); });
	return async (stage: string) => {
		let value = queue.shift();
		if (!value) {
			const prior = settled.get(child);
			if (prior?.error) throw prior.error;
			if (prior) throw new Error(`exit before ${stage} from ${child.pid}`);
			value = await new Promise((resolve, reject) => {
				let timer: ReturnType<typeof setTimeout>;
				const clear = () => { clearTimeout(timer); child.off("exit", onExit); child.off("error", onError); pending = undefined; };
				const onExit = () => { clear(); reject(new Error(`exit before ${stage} from ${child.pid}`)); };
				const onError = (error: Error) => { clear(); reject(error); };
				pending = (message) => { clear(); resolve(message); };
				child.once("exit", onExit);
				child.once("error", onError);
				timer = setTimeout(() => { clear(); reject(new Error(`timeout ${stage} from ${child.pid}`)); }, 3000);
				const current = settled.get(child);
				if (current?.error) onError(current.error);
				else if (current) onExit();
			});
		}
		if (value.stage !== stage) throw new Error(`expected ${stage}, got ${value.stage}`);
		return value;
	};
}
export function send(child: ChildProcess, message: string): Promise<void> {
	return new Promise((resolve, reject) => {
		try { child.send(message, (error) => {
			if (error && (error as NodeJS.ErrnoException).code !== "ERR_IPC_CHANNEL_CLOSED") reject(error);
			else resolve();
		}); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ERR_IPC_CHANNEL_CLOSED") resolve(); else reject(error); }
	});
}

type Request = { child: ChildProcess; next: ReturnType<typeof messages>; pid: (name: string) => number };
type Context = {
	owner: ChildProcess; wrapper: (credential?: string, mode?: string) => Request;
	control: () => ChildProcess; authorize: () => Promise<void>; dir: string; pid: (name: string) => number;
};
export async function scenario(run: (ctx: Context) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "ownership-proto-"));
	const socket = join(dir, "owner.sock");
	const secret = randomBytes(32).toString("hex");
	const owner = tracked(spawn(node.path, [fixture("owner"), socket, secret, join(dir, "owner")], { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
	const ownerNext = messages(owner);
	const wrappers: Array<{ child: ChildProcess; path: string; known: Set<number> }> = [];
	const controls: ChildProcess[] = [];
	const pidAt = (path: string, name: string) => existsSync(join(path, name)) ? Number(readFileSync(join(path, name), "utf8")) : 0;
	const pid = (name: string) => pidAt(dir, name);
	const wrapper = (credential = secret, mode = "hold"): Request => {
		const path = wrappers.length ? join(dir, `request-${wrappers.length}`) : dir;
		mkdirSync(path, { recursive: true });
		const child = tracked(spawn(node.path, [fixture("wrapper"), socket, credential, path, mode], { detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"] }));
		const known = new Set<number>();
		if (child.pid) known.add(child.pid);
		wrappers.push({ child, path, known });
		return { child, next: messages(child), pid: (name) => { const found = pidAt(path, name); if (found) known.add(found); return found; } };
	};
	const control = () => {
		const child = tracked(spawn(node.path, [fileURLToPath(new URL("./fixtures/process-topology.mjs", import.meta.url)), "control"], { detached: true, stdio: "ignore" }));
		controls.push(child);
		return child;
	};
	let failure: unknown;
	try {
		await ownerNext("listening");
		await run({ owner, wrapper, control, authorize: async () => { await send(owner, "authorize"); await ownerNext("authorized"); }, dir, pid });
	} catch (error) { failure = error; }
	const cleanupErrors: unknown[] = [];
	const attempt = (action: () => void) => { try { action(); } catch (error) { cleanupErrors.push(error); } };
	const kill = (target: number) => attempt(() => { try { process.kill(target, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } });
	const killOwnedGroup = (group: number, known: Set<number>) => attempt(() => {
		if (!group || ![...known].some((member) => { const current = state(member); return current.live && current.pgid === group; })) return;
		try { process.kill(-group, "SIGKILL"); }
		catch (error) {
			// A member may have died between ps and kill; EPERM for a vanished
			// group is acceptable only if no recorded member remains live.
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			if ((error as NodeJS.ErrnoException).code === "EPERM" && ![...known].some((member) => { const current = state(member); return current.live && current.pgid === group; })) return;
			throw error;
		}
	});
	for (const { child, path, known } of wrappers) {
		for (const name of ["wrapper", "guardian", "cli-launched", "cli", "leaf"]) attempt(() => { const found = pidAt(path, name); if (found) known.add(found); });
		const group = child.pid ?? pidAt(path, "wrapper");
		killOwnedGroup(group, known);
	}
	for (const child of controls) attempt(() => { if (child.pid && state(child.pid).live && state(child.pid).pgid === child.pid) kill(-child.pid); });
	attempt(() => { if (owner.pid && state(owner.pid).live) kill(owner.pid); });
	for (const { child, path, known } of wrappers) {
		for (const name of ["wrapper", "guardian", "cli-launched", "cli", "leaf"]) attempt(() => { const found = pidAt(path, name); if (found) known.add(found); });
		for (const member of known) {
			try { await until(() => !state(member).live, `cleanup descendant ${member}`); } catch (error) { cleanupErrors.push(error); }
		}
	}
	for (const child of [...wrappers.map((entry) => entry.child), ...controls, owner]) {
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`unreaped child ${child.pid}`)), 3000);
				ended(child).then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
			});
		}
		catch (error) { cleanupErrors.push(error); }
	}
	// Sample again after all direct children have exited: a CLI/leaf may have
	// materialized after the first directory scan during an owner/launch race.
	for (const { child, path, known } of wrappers) {
		for (const name of ["wrapper", "guardian", "cli-launched", "cli", "leaf"]) attempt(() => { const found = pidAt(path, name); if (found) known.add(found); });
		const group = child.pid ?? pidAt(path, "wrapper");
		killOwnedGroup(group, known);
		for (const member of known) {
			try { await until(() => !state(member).live, `late descendant ${member}`); } catch (error) { cleanupErrors.push(error); }
		}
	}
	attempt(() => rmSync(dir, { recursive: true, force: true }));
	if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "ownership scenario failed or cleanup incomplete");
}
