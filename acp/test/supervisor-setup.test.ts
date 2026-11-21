import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { listSupervisorLaunchCommands, saveSupervisorLaunchCommand } from "../src/acp/supervisor-launch-commands.js";
import { parseSupervisorSetupRequest } from "../src/acp/supervisor-setup-contract.js";
import { configureSupervisorProject } from "../src/acp/supervisor-setup.js";
import { createSupervisorStore } from "../src/acp/supervisor-store.js";
import { writeSourcePolicy } from "../src/search/source-policy.js";
import { createSupervisorBridge } from "../src/pi/supervisor-host.js";

async function project(t: TestContext) {
	const parent = fileURLToPath(new URL("../../.pi/artifacts/supervisor-setup-tests/", import.meta.url));
	await mkdir(parent, { recursive: true });
	const cwd = await mkdtemp(join(parent, "project-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

const allow = async () => {};

test("setup accepts configuration only, with no target project or approval parameter", () => {
	for (const op of ["launch-run", "launch-delete", "registry-publish", "registry-remove"]) {
		assert.equal(parseSupervisorSetupRequest({ op }), undefined);
	}
	assert.throws(() => parseSupervisorSetupRequest({ op: "launch-list", cwd: "/elsewhere" }), /Unexpected fields/);
	assert.throws(() => parseSupervisorSetupRequest({ op: "registry-install", name: "test", resourceType: "skill", confirmed: true }), /Unexpected fields/);
	assert.throws(() => parseSupervisorSetupRequest({ op: "registry-install", name: "test", resourceType: "project" }), /Invalid resourceType/);
});

test("launch writes serialize with Search, preserve JSONC and never execute the command", async (t) => {
	const cwd = await project(t);
	const config = join(cwd, ".pi", "workspace.jsonc");
	const marker = join(cwd, "must-not-exist");
	const add = (name: string) => saveSupervisorLaunchCommand(cwd, { op: "launch-add", name, command: `touch ${JSON.stringify(marker)}` }, allow);
	assert.deepEqual(await listSupervisorLaunchCommands(cwd), []);
	await mkdir(join(cwd, ".pi"));
	await writeFile(config, '{\n  // project metadata\n  "wiki": { "path": "wiki" },\n}\n');
	const [first] = await Promise.all([add("First"), add("Second"), writeSourcePolicy(cwd, "tasks", true)]);
	const before = await readFile(config, "utf8");
	assert.match(before, /\/\/ project metadata/);
	assert.match(before, /"tasks": true/);
	assert.deepEqual(parse(before).wiki, { path: "wiki" });
	const edit = { op: "launch-edit", commandId: first.id, revision: first.revision, name: "Renamed" } as const;
	const renamed = await saveSupervisorLaunchCommand(cwd, edit, allow);
	assert.equal(renamed.command, first.command);
	assert.notEqual(renamed.revision, first.revision);
	assert.deepEqual((await listSupervisorLaunchCommands(cwd)).map(({ name }) => name).sort(), ["Renamed", "Second"]);
	await assert.rejects(saveSupervisorLaunchCommand(cwd, edit, allow), /changed or was removed/);
	await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("launch edits reject duplicate keys, stale ownership and cancellation before writing", async (t) => {
	const cwd = await project(t);
	const other = await project(t);
	const store = createSupervisorStore();
	const ctx = { cwd, hasUI: false, ui: { confirm: async () => false, input: async () => undefined, editor: async () => undefined, notify() {} } };
	let live = true;
	const launch = (caller: string) => configureSupervisorProject({
		request: { op: "launch-add", name: "Test", command: "echo test" }, caller, ctx, store,
		registry: { action: async () => { throw new Error("unexpected registry action"); } },
		current: () => live, signal: new AbortController().signal, exclusive: (run) => run(),
	});
	await store.updateRegistry(cwd, (registry) => ({ ...registry, supervisorSessionId: "owner" }));
	await assert.rejects(launch("stranger"), /no longer/);
	await assert.rejects(launch("owner"), /Enable and resume/);
	await store.updateMandate(cwd, { enabled: true });
	live = false;
	await assert.rejects(launch("owner"), /no longer/);
	live = true;
	await assert.rejects(saveSupervisorLaunchCommand(cwd, { op: "launch-add", name: "Test", command: "echo test" }, async () => { throw new Error("cancelled"); }), /cancelled/);
	assert.deepEqual(await listSupervisorLaunchCommands(cwd), []);
	await launch("owner");
	assert.deepEqual(await listSupervisorLaunchCommands(other), []);
	const config = join(cwd, ".pi", "workspace.jsonc");
	const duplicate = '{"launchCommands":[],"launchCommands":[]}';
	await writeFile(config, duplicate);
	await assert.rejects(launch("owner"), /workspace.jsonc/);
	assert.equal(await readFile(config, "utf8"), duplicate);
});

for (const mode of ["abort", "retire"] as const) test(`Pi setup ${mode} forwards cancellation with the original request id`, async () => {
	const events: { type: string; requestId: string }[] = [];
	const bridge = createSupervisorBridge({ sessionManager: { getSessionId: () => "owner" } }, (event: typeof events[number]) => events.push(event));
	const controller = new AbortController();
	const pending = bridge.request({ ownerSessionId: "owner", op: "launch-list" }, controller.signal);
	if (mode === "abort") controller.abort();
	else bridge.dispose();
	await assert.rejects(pending, /cancelled|runtime closed/);
	assert.deepEqual(events.map(({ type }) => type), ["pix_supervisor_request", "pix_supervisor_setup_cancel"]);
	assert.equal(events[0]?.requestId, events[1]?.requestId);
});
