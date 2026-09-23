import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSubagentConfig, resolveAgentTaskConfig } from "../../../src/async-subagents/core/config.js";
import { generatePrompt } from "../../../src/async-subagents/core/prompt.js";
import { auditActions, hasConfidence, parseOutput, snapshot } from "./assertions.js";
import { CASES, prepareFixture } from "./fixtures.js";

export { CASES } from "./fixtures.js";
const profilePath = path.resolve(import.meta.dirname, "../../../src/async-subagents/agents/delivery-review.md");
function profileHash(): string {
	return crypto.createHash("sha256").update(fs.readFileSync(profilePath)).digest("hex");
}

function resolve(project: string, task: string) {
	const resolved = resolveAgentTaskConfig({ id: "delivery-review", task, subagentType: "delivery-review" },
		loadSubagentConfig(project, {}), { parentModel: "openai-codex/gpt-6-sol" });
	if (resolved.task.model !== "openai-codex/gpt-6-sol" || resolved.task.thinking !== "high"
		|| JSON.stringify(resolved.task.tools) !== JSON.stringify(["read", "grep", "bash"])) {
		throw new Error("delivery-review did not resolve to GPT-6 Sol/high with inspection tools");
	}
	return resolved;
}

export function profile() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-config-"));
	try { return { resolved: resolve(dir, "Review the supplied change."), sha256: profileHash() }; }
	finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function runPi(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of ["PIX_ACP_SESSION_STATE_BRIDGE", "PIX_QUESTION_RPC_BRIDGE", "PIX_CONFIG_PROFILE"]) delete env[key];
	return new Promise((resolve, reject) => {
		const child = spawn("pi", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "", timedOut = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		function kill(signal: NodeJS.Signals): void {
			if (!child.pid) return;
			try { process.kill(-child.pid, signal); } catch { /* Already exited. */ }
		}
		const timer = setTimeout(() => {
			timedOut = true;
			kill("SIGTERM");
			killTimer = setTimeout(() => kill("SIGKILL"), 1000);
		}, 180_000);
		function clear(): void { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); }
		child.stdout.on("data", chunk => { stdout += chunk.toString(); });
		child.stderr.on("data", chunk => { stderr += chunk.toString(); });
		child.once("error", error => { clear(); reject(error); });
		child.once("close", exitCode => { clear(); resolve({ stdout, stderr, exitCode, timedOut }); });
	});
}

export async function runCase(id: typeof CASES[number]["id"], artifactDir: string) {
	const { project, task } = prepareFixture(id);
	const before = snapshot(project);
	const resolved = resolve(project, task);
	const sha256 = profileHash();
	const prompt = generatePrompt(resolved.task);
	const args = ["--model", resolved.task.model!, "--thinking", resolved.task.thinking!, "--tools", resolved.task.tools!.join(","),
		"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-session", "--mode", "json", "-p", prompt];
	const execution = await runPi(args, project);
	const parsed = parseOutput(execution.stdout);
	const after = snapshot(project);
	const issues = auditActions(parsed.actions);
	if (JSON.stringify(before) !== JSON.stringify(after)) issues.push("fixture mutated");
	if (profileHash() !== sha256) issues.push("profile changed during run");
	if (!hasConfidence(parsed.text)) issues.push("missing explicit confidence");
	if (!parsed.actions.length) issues.push("no inspection actions");
	if (!parsed.models.length || parsed.models.some(model => model !== "gpt-6-sol")) issues.push(`unexpected actual model: ${parsed.models}`);
	const status = execution.timedOut || execution.exitCode !== 0 || !parsed.text ? "incomplete" : issues.length ? "failed" : "passed";
	fs.mkdirSync(artifactDir, { recursive: true });
	const artifact = path.join(artifactDir, `${id}.json`);
	fs.writeFileSync(artifact, JSON.stringify({ id, project, status, issues, model: resolved.task.model, thinking: resolved.task.thinking,
		profileSha256: sha256, args, before, after, ...execution, ...parsed, semanticReview: "pending human review" }, null, 2));
	return { id, status, issues, artifact };
}
