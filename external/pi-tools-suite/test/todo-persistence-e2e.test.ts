import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withE2ERetry } from "./e2e-retry.js";

const EXTENSION_ENTRYPOINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
const E2E_TIMEOUT_MS = Number(process.env.TODO_PERSISTENCE_E2E_TIMEOUT_MS ?? 45_000);
const KEEP_E2E_DIRS = /^(1|true|yes)$/i.test(process.env.TODO_PERSISTENCE_E2E_KEEP ?? "");
const STREAM_IO = /^(1|true|yes)$/i.test(process.env.TODO_PERSISTENCE_E2E_STREAM_IO ?? "");
const RUN_IN_CI = /^(1|true|yes)$/i.test(process.env.TODO_PERSISTENCE_E2E_CI ?? "");
const TODO_PERSISTENCE_TEST = process.env.CI && !RUN_IN_CI ? test.skip : test;

type PiRun = {
	stdout: string;
	stderr: string;
	elapsedMs: number;
};

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-persistence-e2e-"));
	try {
		return await fn(projectDir);
	} finally {
		if (!KEEP_E2E_DIRS) fs.rmSync(projectDir, { recursive: true, force: true });
	}
}

function writePlan(projectDir: string): string {
	const planPath = path.join(projectDir, ".pi", "todo-plan.json");
	fs.mkdirSync(path.dirname(planPath), { recursive: true });
	fs.writeFileSync(
		planPath,
		JSON.stringify(
			{
				version: 1,
				enabled: true,
				updatedAt: "2026-01-01T00:00:00.000Z",
				nextId: 3,
				tasks: [
					{ id: 1, subject: "Continue selected implementation", status: "pending", priority: "high" },
					{ id: 2, subject: "Defer out-of-scope cleanup", status: "pending", priority: "medium" },
				],
			},
			null,
			2,
		),
		"utf-8",
	);
	return planPath;
}

async function runPi(projectDir: string, prompt: string, label: string): Promise<PiRun> {
	return withE2ERetry(label, async () => {
		const sessionDir = path.join(projectDir, ".pi", `e2e-session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(sessionDir, { recursive: true });
		const args = [
			"--extension", EXTENSION_ENTRYPOINT,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--session-dir", sessionDir,
			"--no-session",
			"--no-tools",
			"-p", prompt,
		];

		const startedAt = Date.now();
		const child = spawn("pi", args, {
			cwd: projectDir,
			env: {
				...process.env,
				PI_OFFLINE: "1",
				NO_COLOR: "1",
				CI: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			stdout += text;
			if (STREAM_IO) console.error(`[todo-persistence stdout:${label}] ${text.trimEnd()}`);
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			stderr += text;
			if (STREAM_IO) console.error(`[todo-persistence stderr:${label}] ${text.trimEnd()}`);
		});

		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const timeout = setTimeout(() => {
				child.kill("SIGTERM");
				reject(new Error(`pi todo persistence e2e (${label}) timed out after ${E2E_TIMEOUT_MS}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
			}, E2E_TIMEOUT_MS);
			child.once("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timeout);
				resolve(code);
			});
		});

		const elapsedMs = Date.now() - startedAt;
		if (exitCode !== 0) {
			throw new Error(`pi todo persistence e2e (${label}) exited with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
		}
		return { stdout, stderr, elapsedMs };
	}, {
		onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
			if (STREAM_IO) console.error(
				`[todo-persistence retry:${label}] 429/rate-limit on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
			);
		},
	});
}

describe("todo persistence real pi e2e", () => {
	TODO_PERSISTENCE_TEST("loads a project plan, scopes it, and waits out the duplicate auto-nudge window", async () => {
		await withTempProject(async (projectDir) => {
			const planPath = writePlan(projectDir);

			const scoped = await runPi(projectDir, "/todos-scope #1", "scope");
			const scopeOutput = `${scoped.stdout}\n${scoped.stderr}`;
			expect(scopeOutput).toContain("Persisted todo plan loaded");
			expect(scopeOutput).toContain("Todo scope selected: #1");
			expect(scopeOutput).toContain("Deferred out-of-scope active tasks: 1");

			const scopedPlan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
			expect(scopedPlan.tasks.find((task: any) => task.id === 1).status).toBe("pending");
			expect(scopedPlan.tasks.find((task: any) => task.id === 2).status).toBe("deferred");

			const resumed = await runPi(projectDir, "ping", "resume-and-wait");
			const resumeOutput = `${resumed.stdout}\n${resumed.stderr}`;
			expect(resumeOutput).toContain("Persisted todo plan loaded");
			expect(resumeOutput).toContain("#1 [pending] (high) Continue selected implementation");
			expect(resumeOutput).toContain("#2 [deferred] (medium) Defer out-of-scope cleanup");
			expect(resumeOutput).not.toContain("Todo auto-nudge");
			// The child process stays alive long enough for the post-agent nudge
			// window to run; this catches duplicate reminder regressions without
			// making the assertion depend on exact CLI startup timing.
			expect(resumed.elapsedMs).toBeGreaterThanOrEqual(3_500);
		});
	}, E2E_TIMEOUT_MS + 5_000);
});
