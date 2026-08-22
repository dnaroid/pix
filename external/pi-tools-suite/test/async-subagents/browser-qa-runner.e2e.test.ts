import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzipSync } from "../../src/async-subagents/private-skills/browser-qa/vendor/fflate.mjs";

const RUN_E2E = /^(?:1|true|yes)$/i.test(process.env.BROWSER_QA_RUNNER_E2E ?? "");
const KEEP_EVIDENCE = !/^(?:0|false|no)$/i.test(process.env.BROWSER_QA_KEEP_EVIDENCE ?? "");
const e2eTest = RUN_E2E ? test : test.skip;
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const runner = path.resolve(
	testDirectory,
	"../../src/async-subagents/private-skills/browser-qa/scripts/browser-qa-runner.mjs",
);
const mockPage = fs.readFileSync(path.resolve(testDirectory, "../fixtures/browser-qa/mock-page.html"), "utf8");

e2eTest("captures real screenshot, video, and trace artifacts from a local mock page", async () => {
	let receivedAuthCookie = false;
	const server = createServer((request, response) => {
		receivedAuthCookie ||= request.headers.cookie?.includes("session=mock-session-secret") === true;
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(mockPage);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	const project = fs.mkdtempSync(path.join(os.tmpdir(), "browser-qa-real-e2e-"));
	let publishedArtifacts: ArtifactManifest | undefined;
	try {
		const { port } = server.address() as AddressInfo;
		const origin = `http://127.0.0.1:${port}`;
		const agentDir = createBrowserQaAgent(project);
		writePrivateJson(path.join(project, ".pi", "qa_auth.jsonc"), {
			profiles: {
				mock: {
					description: "Local browser QA mock",
					traits: ["test:mock"],
					baseUrl: origin,
					allowedOrigins: [origin],
					auth: {
						type: "cookie",
						cookies: [{ name: "session", value: "mock-session-secret", url: origin }],
					},
				},
			},
		});
		const flowPath = path.join(agentDir, "browser-qa", "flows", "mock.jsonc");
		writePrivateJson(flowPath, {
			steps: [
				{ action: "goto", path: "/" },
				{ action: "assertVisible", locator: { testId: "qa-title" } },
				{ action: "assertText", locator: { testId: "qa-title" }, equals: "Browser QA Mock" },
				{ action: "waitForTimeout", timeoutMs: 500 },
				{ action: "screenshot", name: "mock-page" },
			],
		});

		const result = await runRunner(project, [
			"run",
			"--profile", "mock",
			"--flow", flowPath,
			"--run-id", "real-artifacts",
		], agentDir);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.json).toMatchObject({ status: "QA_PASSED", profile: "mock" });
		expect(receivedAuthCookie).toBe(true);

		const evidenceDir = path.join(fs.realpathSync(agentDir), "browser-qa", "evidence", "real-artifacts", "mock");
		const screenshots = result.json.artifacts.screenshots;
		expect(screenshots.map((artifact) => path.basename(artifact.path)).sort()).toEqual(["final.png", "mock-page.png"]);
		expect(result.json.artifacts.videos).toHaveLength(1);
		expect(result.json.artifacts.traces).toHaveLength(1);

		for (const artifact of [...screenshots, ...result.json.artifacts.videos, ...result.json.artifacts.traces] as Artifact[]) {
			expect(artifact.path.startsWith(evidenceDir)).toBe(true);
			expect(artifact.uri).toBe(pathToFileURL(artifact.path).href);
			expect(fs.statSync(artifact.path).size).toBeGreaterThan(100);
		}
		expect(fs.readFileSync(screenshots[0].path).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		expect(fs.readFileSync(result.json.artifacts.videos[0].path).subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
		const traceEntries = unzipSync(new Uint8Array(fs.readFileSync(result.json.artifacts.traces[0].path)), {});
		expect(Object.keys(traceEntries)).toContain("trace.trace");
		expect(fs.existsSync(path.join(project, ".pi", "qa-runs"))).toBe(false);

		if (KEEP_EVIDENCE) {
			publishedArtifacts = publishEvidence(result.json.artifacts);
			for (const artifact of allArtifacts(publishedArtifacts)) {
				expect(fs.existsSync(artifact.path)).toBe(true);
				expect(artifact.uri).toBe(pathToFileURL(artifact.path).href);
			}
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(project, { recursive: true, force: true });
	}
	if (publishedArtifacts) printArtifactLinks(publishedArtifacts);
}, 120_000);

type Artifact = { path: string; uri: string };
type ArtifactManifest = { screenshots: Artifact[]; videos: Artifact[]; traces: Artifact[] };
type RunnerStatus = {
	status: string;
	profile?: string;
	artifacts: ArtifactManifest;
};

function publishEvidence(artifacts: ArtifactManifest): ArtifactManifest {
	const outputDirectory = path.join(repositoryRoot, ".pi", "qa-runs", "browser-qa-e2e", "latest");
	fs.rmSync(outputDirectory, { recursive: true, force: true });
	fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
	const copyGroup = (group: Artifact[]): Artifact[] => group.map((artifact) => {
		const outputPath = path.join(outputDirectory, path.basename(artifact.path));
		fs.copyFileSync(artifact.path, outputPath);
		fs.chmodSync(outputPath, 0o600);
		return { path: outputPath, uri: pathToFileURL(outputPath).href };
	});
	return {
		screenshots: copyGroup(artifacts.screenshots),
		videos: copyGroup(artifacts.videos),
		traces: copyGroup(artifacts.traces),
	};
}

function allArtifacts(artifacts: ArtifactManifest): Artifact[] {
	return [...artifacts.screenshots, ...artifacts.videos, ...artifacts.traces];
}

function printArtifactLinks(artifacts: ArtifactManifest): void {
	console.error("\nBrowser QA artifacts retained for inspection:");
	for (const [label, group] of [
		["Screenshot", artifacts.screenshots],
		["Video", artifacts.videos],
		["Trace", artifacts.traces],
	] as const) {
		for (const artifact of group) {
			console.error(`- ${label}: [${path.basename(artifact.path)}](${artifact.uri})`);
			console.error(`  ${artifact.path}`);
		}
	}
}

function writePrivateJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

function createBrowserQaAgent(project: string): string {
	const agentDir = path.join(project, ".pi", "subagents", "browser-qa-e2e", "qa-agent");
	const workspace = path.join(agentDir, "browser-qa");
	const flows = path.join(workspace, "flows");
	fs.mkdirSync(flows, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentDir, "prompt.md"), "browser QA E2E\n", "utf8");
	fs.writeFileSync(path.join(agentDir, "project_cwd"), project, "utf8");
	fs.writeFileSync(path.join(agentDir, "subagent_type"), "browser-qa", "utf8");
	if (process.platform !== "win32") {
		fs.chmodSync(workspace, 0o700);
		fs.chmodSync(flows, 0o700);
	}
	return fs.realpathSync(agentDir);
}

async function runRunner(project: string, args: string[], agentDir: string): Promise<{ code: number | null; stdout: string; stderr: string; json: RunnerStatus }> {
	const child = spawn("node", [runner, ...args], {
		cwd: project,
		env: { ...process.env, PI_SUBAGENT_AGENT_DIR: agentDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	const trimmedStdout = stdout.trim();
	if (!trimmedStdout) throw new Error(`browser QA runner produced no status (exit ${code}): ${stderr.trim()}`);
	return {
		code,
		stdout: trimmedStdout,
		stderr: stderr.trim(),
		json: JSON.parse(trimmedStdout) as RunnerStatus,
	};
}
