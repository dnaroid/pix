import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import subagentRepoDiscovery from "../../src/repo-discovery/subagent.js";
import { REPO_DISCOVERY_TOOLS } from "../../src/tool-descriptions.js";
import { installFakeIdxOnPath } from "../support/fake-idx.js";

const scratchRoot = resolve(import.meta.dir, "../../../../.pi/artifacts/subagent-repo-tests");
const workspaces: string[] = [];
afterEach(() => {
	for (const cwd of workspaces.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

function workspace(): string {
	mkdirSync(scratchRoot, { recursive: true });
	const root = mkdtempSync(join(scratchRoot, "run-"));
	mkdirSync(join(root, ".git")); // Isolate discovery from the real ancestor index.
	workspaces.push(root);
	return root;
}

function harness(root: string, indexed: boolean, idxAvailable = true) {
	if (indexed) mkdirSync(join(root, ".indexer-cli"));
	const oldCwd = process.cwd();
	const restorePath = installFakeIdxOnPath(root);
	const registered: any[] = [], commands: string[] = [], calls: any[] = [];
	const handlers = new Map<string, Function>();
	let active = ["read", "todo"];
	try {
		process.chdir(root);
		if (!idxAvailable) process.env.PATH = join(root, "unavailable");
		subagentRepoDiscovery({
			registerTool: (tool: any) => registered.push(tool),
			registerCommand: (name: string) => commands.push(name),
			on: (event: string, handler: Function) => handlers.set(event, handler),
			getAllTools: () => [...registered, { name: "read" }, { name: "todo" }],
			getActiveTools: () => active,
			setActiveTools: (tools: string[]) => { active = tools; },
			exec: async (...args: any[]) => { calls.push(args); return { stdout: "query evidence", stderr: "", code: 0 }; },
		} as any);
	} finally {
		process.chdir(oldCwd);
		restorePath();
	}
	return { registered, commands, calls, active: () => active,
		restrict: (tools: string[]) => { active = tools; },
		emit: (event: string) => handlers.get(event)!(),
		execute: (name: string, params: unknown, signal?: AbortSignal) => registered.find((tool) => tool.name === name).execute("call", params, signal, undefined, { cwd: root }),
	};
}

test("common repo facade exposes only eight queries, no setup or recursive orchestration", () => {
	const child = harness(workspace(), true);
	expect(child.registered.map((tool) => tool.name)).toEqual(REPO_DISCOVERY_TOOLS.map((tool) => tool.name));
	expect(child.commands).toEqual([]);
	expect(child.calls).toEqual([]);
	const audit = child.registered.find((tool) => tool.name === "repo_audit");
	expect(audit.promptSnippet).not.toContain("knowledge-auditor");
	expect(audit.promptGuidelines.join("\n")).toContain("do not delegate");
	for (const event of ["session_start", "model_select"]) {
		child.restrict(["read", "todo"]);
		child.emit(event);
		child.emit(event);
		expect(child.active()).toEqual(["read", "todo", ...REPO_DISCOVERY_TOOLS.map((tool) => tool.name)]);
	}
});

for (const [indexed, idxAvailable] of [[false, true], [true, false]]) {
	test(`missing prerequisite does not register tools or initialize (indexed=${indexed}, idx=${idxAvailable})`, () => {
		const root = workspace();
		const child = harness(root, indexed, idxAvailable);
		child.emit("session_start");
		expect(child.registered).toEqual([]);
		expect(child.commands).toEqual([]);
		expect(child.calls).toEqual([]);
		expect(child.active()).toEqual(["read", "todo"]);
		expect(existsSync(join(root, ".indexer-cli"))).toBe(indexed);
	});
}

test("query adapters retain cancellation, explicit-root validation and read-only audit", async () => {
	const root = workspace();
	const child = harness(root, true);
	const abort = new AbortController();
	abort.abort();
	await child.execute("repo_context", { query: "contract" }, abort.signal);
	expect(child.calls).toEqual([]);
	const invalid = await child.execute("repo_context", { query: "contract", projectPath: join(root, "missing") });
	expect(invalid.isError).toBe(true);
	expect(child.calls).toEqual([]);
	const restorePath = installFakeIdxOnPath(root);
	try {
		const signal = new AbortController().signal;
		await child.execute("repo_context", { query: "contract" }, signal);
		await child.execute("repo_audit", { paths: ["src/example.ts"], noSemantic: true }, signal);
		expect(child.calls[0][0]).toBe("idx");
		expect(child.calls[0][1].slice(0, 2)).toEqual(["context", "contract"]);
		expect(child.calls[0][2]).toMatchObject({ cwd: root, signal });
		expect(child.calls[1][1]).toEqual(["audit", "src/example.ts", "--no-semantic"]);
		expect(process.cwd()).not.toBe(root);
	} finally { restorePath(); }
});
