import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import type { Writable } from "node:stream";

// Keep stdin errors observed even if Q closes before the runner's release.
export function observeInput(input: Writable) {
	const errors: Error[] = [];
	input.on("error", (error: Error) => { errors.push(error); });
	return {
		errors,
		write(value: string) { input.write(value, (error?: Error | null) => { if (error) errors.push(error); }); },
		end() {
			if (!input.writableEnded) input.end((error?: Error | null) => { if (error) errors.push(error); });
		},
	};
}

export async function closeWithin(close: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			close.then(() => true),
			new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
		]);
	} finally { if (timer) clearTimeout(timer); }
}

// Only the owned direct child may be signaled. Q close alone cannot establish
// K's cleanup: require the asserted native completion EOF before deletion.
export async function finishFixture(dir: string, close: Promise<unknown>, child: Pick<ChildProcess, "kill">, ms: number, completionConfirmed: boolean) {
	let closed = await closeWithin(close, ms);
	if (!closed) {
		let killError: unknown;
		try { child.kill(); } catch (error) { killError = error; }
		closed = await closeWithin(close, ms);
		if (!closed && killError) throw new Error(`native child close unconfirmed; retained fixture directory: ${dir}; direct-child backstop failed: ${String(killError)}`);
	}
	if (!closed) throw new Error(`native child close unconfirmed; retained fixture directory: ${dir}`);
	if (!completionConfirmed) throw new Error(`native K completion unconfirmed; retained fixture directory: ${dir}`);
	rmSync(dir, { recursive: true, force: true });
}
