// Copied into a verified, isolated provider snapshot only; never installed.
import { spawn, type ChildProcess } from "node:child_process";
import type { ProcessSupervisorOptions, ProcessSupervisor } from "./process-utils.ts";
import { ProcessTerminationError, type superviseProcess } from "./process-utils.ts";

export function nativeSpawn(binary: string, command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdin: "pipe" | "ignore" }): ChildProcess {
	return spawn(binary, [command, ...args], {
		cwd: options.cwd, env: options.env, detached: false, windowsHide: true,
		stdio: [options.stdin, "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
	});
}

export function nativeSupervisor(child: ChildProcess, options: ProcessSupervisorOptions, supervise: typeof superviseProcess): ProcessSupervisor {
	const control = child.stdio[3] as NodeJS.WritableStream;
	const report = child.stdio[4] as NodeJS.ReadableStream;
	let text = "";
	// Resolve to an outcome immediately: an early stream failure must never be
	// an unobserved rejection while the provider is still reading stdout.
	type Outcome = { value: string; error?: never } | { value?: never; error: Error };
	const receipt = new Promise<Outcome>((resolve) => {
		let settled = false;
		const finish = (outcome: Outcome) => { if (!settled) { settled = true; resolve(outcome); } };
		report.on("data", (chunk: Buffer) => {
			if (settled) return;
			if (Buffer.byteLength(text) + chunk.length > 64) { text = ""; finish({ error: new Error("Oversized native cleanup receipt") }); return; }
			text += chunk.toString();
		});
		report.once("error", (error: Error) => finish({ error }));
		report.once("end", () => finish({ value: text }));
		report.once("close", () => finish({ error: new Error("Native cleanup receipt closed without end") }));
		child.once("close", () => finish({ error: new Error("Native child closed without cleanup receipt end") }));
		child.once("error", (error: Error) => finish({ error }));
	});
	let controlError: Error | undefined;
	control.on("error", (error: Error) => { controlError = error; });
	const close = new Promise<Error | undefined>((resolve) => {
		child.once("close", () => resolve(undefined));
		child.once("error", (error: Error) => resolve(error));
	});
	// The provider's normal stdin.close must NOT cancel this separate liveness pipe.
	const terminate = async (): Promise<void> => {
		let endError: Error | undefined;
		const socket = control as NodeJS.WritableStream & { writableEnded?: boolean; destroyed?: boolean; destroy?: () => void };
		if (!socket.writableEnded && !socket.destroyed) {
			// Graceful half-close first; its completion is irrelevant because the
			// forced close below is what must deliver the EOF to the native relay.
			try { control.end(); } catch { /* already tearing down; the destroy still closes */ }
		}
		// Bun can drop the fd close when end() races spawn setup, leaving the
		// native relay unaware of the control EOF; force the socket closed.
		if (!socket.destroyed && socket.destroy) {
			try { socket.destroy(); }
			catch (error) { endError = error as Error; }
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let observed: Outcome;
		let closeError: Error | undefined;
		try {
			[observed, closeError] = await Promise.race([
				Promise.all([receipt, close]).then(([value, error]) => [value, error] as const),
				new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native cleanup receipt/close timed out")), 5_000); }),
			]);
		} finally { if (timer) clearTimeout(timer); }
		if (controlError || endError || closeError || observed.error) throw controlError ?? endError ?? closeError ?? observed.error;
		const expected = child.exitCode;
		if (expected === null || observed.value !== `CLEAN:${expected}\n`) throw new Error(`Invalid native cleanup receipt: ${JSON.stringify(observed.value)}; exit=${String(expected)}`);
	};
	// Override even a caller-injected supervisor's termination path: it may use
	// negative-child.pid signaling after A has exited and been reaped by Node.
	return supervise(child, { ...options, terminate: () => terminate().catch((error) => {
			throw error instanceof ProcessTerminationError ? error : new ProcessTerminationError(error);
		}) });
}
