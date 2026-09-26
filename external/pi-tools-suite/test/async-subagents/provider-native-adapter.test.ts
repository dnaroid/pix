import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

// The adapter's process-utils import belongs to the provider snapshot: stage
// a minimal offline module instead of resolving a nonexistent suite import.
test("staged native adapter observes early receipt/error, bounds input, and rejects EPIPE/close", async () => {
	const dir = mkdtempSync(join(tmpdir(), "native-adapter-test-"));
	try {
		copyFileSync(fileURLToPath(new URL("./provider-native-adapter.ts", import.meta.url)), join(dir, "provider-native-adapter.ts"));
		writeFileSync(join(dir, "process-utils.ts"), `export class ProcessTerminationError extends Error { constructor(cause) { super(String(cause)); this.name = "ProcessTerminationError"; this.livenessUnknown = true; } }`);
		const { nativeSupervisor } = await import(pathToFileURL(join(dir, "provider-native-adapter.ts")).href);
		const make = () => {
			const child = new EventEmitter() as ChildProcess;
			const control = new PassThrough();
			const report = new PassThrough();
			Object.assign(child, { stdio: [null, null, null, control, report], exitCode: 0 });
			let terminate!: () => Promise<void>;
			nativeSupervisor(child, {}, (_child: ChildProcess, options: { terminate: () => Promise<void> }) => {
				terminate = options.terminate;
				return {} as ReturnType<typeof nativeSupervisor>;
			});
			return { child, control, report, terminate };
		};
		{
			const { child, report, terminate } = make();
			report.emit("error", new Error("receipt stream error")); // before terminate
			child.emit("close");
			await expect(terminate()).rejects.toThrow("receipt stream error");
		}
		{
			const { child, report, terminate } = make();
			for (let i = 0; i < 100; i++) report.write(Buffer.alloc(1024, 65));
			report.end(); child.emit("close");
			await expect(terminate()).rejects.toThrow("Oversized native cleanup receipt");
		}
		{
			const { child, control, report, terminate } = make();
			control.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
			report.end("CLEAN:0\n"); child.emit("close");
			await expect(terminate()).rejects.toThrow("broken pipe");
		}
		{
			const { child, report, terminate } = make();
			report.emit("close"); child.emit("close");
			await expect(terminate()).rejects.toThrow("closed without end");
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
