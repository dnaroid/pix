import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scenario, state, stopped, until, ended, send } from "./ownership-harness.ts";

for (const [completion, code] of [["complete", 0], ["complete-fail", 7]] as const) {
	test.skipIf(process.platform === "win32")(`offline joint race: CLI ${code} exit preempts guardian loss (unsafe candidate)`, async () => {
		await scenario(async ({ authorize, wrapper, control, dir }) => {
			await authorize();
			const unrelated = control();
			const request = wrapper(undefined, "joint-race");
			const ready = await request.next("guardian-ready");
			await send(request.child, "launch");
			const launched = await request.next("cli-launched");
			await until(() => request.pid("leaf") > 0 && state(request.pid("leaf")).live, "live leaf before completion");
			const leaf = request.pid("leaf");
			const wrapperPid = request.child.pid!;
			const marker = join(dir, "cli-exit-stop-code");
			try {
				expect(state(ready.guardian).live).toBe(true);
				expect(state(launched.pid).live).toBe(true);
				await send(request.child, completion);
				await until(() => existsSync(marker) && stopped(wrapperPid), "real CLI exit callback stopped wrapper");
				expect(Number(readFileSync(marker, "utf8"))).toBe(code);
				expect(state(wrapperPid).pgid).toBe(wrapperPid);
				expect(state(wrapperPid).live).toBe(true);
				expect(state(ready.guardian).live).toBe(true);
				expect(state(leaf).live).toBe(true);
				process.kill(ready.guardian, "SIGKILL");
				await until(() => !state(ready.guardian).live, "guardian nonlive before wrapper resume");
				expect(stopped(wrapperPid)).toBe(true);
				process.kill(wrapperPid, "SIGCONT");
				expect(await ended(request.child)).toBe(code);
				// Before scenario's finally/backstop kills the owned group: guardian
				// cannot clean up, and wrapper's queued loss callback never ran.
				expect(state(ready.guardian).live).toBe(false);
				expect(state(leaf).live).toBe(true);
				expect(state(unrelated.pid!).live).toBe(true);
			} finally {
				// Never leave a paused actor behind if an earlier assertion fails.
				if (stopped(wrapperPid)) {
					try { process.kill(wrapperPid, "SIGCONT"); }
					catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
				}
			}
		});
	}, 12000);
}
