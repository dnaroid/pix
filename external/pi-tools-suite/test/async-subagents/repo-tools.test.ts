import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import subagentRepoDiscovery from "../../src/repo-discovery/subagent.js";
import projectSearch from "../../src/project-search/index.js";

const scratchRoot = resolve(import.meta.dir, "../../../../.pi/artifacts/subagent-repo-tests");
const workspaces: string[] = [];
afterEach(() => {
	for (const cwd of workspaces.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

function workspace(): string {
	mkdirSync(scratchRoot, { recursive: true });
	const root = mkdtempSync(join(scratchRoot, "run-"));
	execFileSync("git", ["init", "--quiet", root]);
	workspaces.push(root);
	return root;
}

function harness(root: string) {
	const oldCwd = process.cwd();
	const registered: any[] = [], commands: string[] = [], calls: any[] = [];
	const handlers = new Map<string, Function>();
	let active = ["read", "todo"];
	try {
		process.chdir(root);
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
	}
	return { registered, commands, calls, active: () => active,
		restrict: (tools: string[]) => { active = tools; },
		emit: (event: string) => handlers.get(event)!(),
		execute: (name: string, params: unknown, signal?: AbortSignal) => registered.find((tool) => tool.name === name).execute("call", params, signal, undefined, { cwd: root }),
	};
}

test("common repo facade registers full project_search, no setup or orchestration", () => {
	const child = harness(workspace());
	expect(child.registered.map((tool) => tool.name)).toEqual(["project_search"]);
	expect(child.registered.map((tool) => tool.name)).not.toContain("repo_search");
	expect(child.commands).toEqual([]);
	expect(child.calls).toEqual([]);
	for (const event of ["session_start", "model_select"]) {
		child.restrict(["read", "todo"]);
		child.emit(event);
		child.emit(event);
		expect(child.active()).toEqual(["read", "todo", "project_search"]);
	}
});

for (const legacyConfig of [false, true]) {
    test(`native registration is independent of legacy files (legacyConfig=${legacyConfig})`, () => {
		const root = workspace();
		if (legacyConfig) mkdirSync(join(root, ".indexer-cli"));
		const child = harness(root);
		child.emit("session_start");
        expect(child.registered.map(tool => tool.name)).toEqual(["project_search"]);
		expect(child.commands).toEqual([]);
		expect(child.calls).toEqual([]);
        expect(child.active()).toEqual(["read", "todo", "project_search"]);
		expect(existsSync(join(root, ".indexer-cli"))).toBe(legacyConfig);
	});
}

test("child project_search shares the parent schema and permits all sources and patches", async () => {
	const root = workspace();
	writeFileSync(join(root, "example.ts"), "export const needle = true;\n");
	execFileSync("git", ["add", "example.ts"], { cwd: root });
	execFileSync("git", ["-c", "user.name=Search Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "search history fixture"], { cwd: root });
	const child = harness(root);
	const search = child.registered.find((tool) => tool.name === "project_search");
	expect(search).toBeDefined();
	let parentTool: any;
	projectSearch({ registerTool: (tool: any) => { parentTool = tool; }, registerCommand: () => {} } as any);
	expect(search.parameters).toEqual(parentTool.parameters);
	expect(search.description).toEqual(parentTool.description);
	expect(search.parameters.properties.sources.items.enum).toEqual(["sessions", "tasks", "commits", "code", "knowledge"]);
	for (const sources of [["sessions"], ["tasks"], ["commits"], ["code", "sessions"]]) {
		const result = await child.execute("project_search", { query: "search history", sources, indexMode: "lexical" });
		expect(result.isError).toBeUndefined();
		expect(result.details.sources).toEqual(sources);
	}
	const patch = await child.execute("project_search", { query: "patch:needle", indexMode: "lexical" });
	expect(patch.isError).toBeUndefined();
	expect(patch.details.sources).toEqual(["commits"]);
	expect(patch.details.results).toContainEqual(expect.objectContaining({ kind: "commits", title: "search history fixture" }));
	child.calls.length = 0;

    const retired = await child.execute("project_search", { query: "worker", sources: ["code"], indexBackend: "idx" });
    expect(retired.isError).toBe(true);
    expect(child.calls).toEqual([]);
});

test("native child search works without IDX and keeps the shared default sources", async () => {
    const root = workspace();
    writeFileSync(join(root, "worker.ts"), "export const uniqueSemaphoreSignal = true;\n");
    const child = harness(root);
    const result = await child.execute("project_search", { query: "uniqueSemaphoreSignal", indexMode: "lexical" });
    expect(result.isError).toBeUndefined();
    expect(result.details.sources).toEqual(["sessions", "tasks", "commits", "code", "knowledge"]);
    expect(result.details.results).toContainEqual(expect.objectContaining({ kind: "code", path: "worker.ts", startLine: 1 }));
    expect(child.calls).toEqual([]);
    expect(existsSync(join(root, ".indexer-cli"))).toBe(false);
});
