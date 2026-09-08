import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import resourceRegistry, { __test } from "../src/resource-registry/index.js";

const originalHome = process.env.HOME;
const originalCache = process.env.XDG_CACHE_HOME;
const originalRpcStateBridge = process.env.PIX_ACP_SESSION_STATE_BRIDGE;
const roots: string[] = [];

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalCache === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = originalCache;
	if (originalRpcStateBridge === undefined) delete process.env.PIX_ACP_SESSION_STATE_BRIDGE;
	else process.env.PIX_ACP_SESSION_STATE_BRIDGE = originalRpcStateBridge;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-registry-test-"));
	roots.push(root);
	return root;
}

function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Registry Test",
			GIT_AUTHOR_EMAIL: "registry@example.test",
			GIT_COMMITTER_NAME: "Registry Test",
			GIT_COMMITTER_EMAIL: "registry@example.test",
		},
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
	return result.stdout.toString().trim();
}

function createRegistry(root: string): { remote: string; seed: string } {
	const seed = path.join(root, "seed");
	const remote = path.join(root, "registry.git");
	fs.mkdirSync(path.join(seed, "skills", "demo"), { recursive: true });
	fs.mkdirSync(path.join(seed, "agents"), { recursive: true });
	fs.writeFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "---\ndescription: Demo skill\n---\n\nv1\n");
	fs.writeFileSync(path.join(seed, "agents", "reviewer.md"), "---\ndescription: Review code\nmodels: [test/model]\n---\n\nReview carefully.\n");
	git(seed, ["init"]);
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "Initial resources"]);
	git(seed, ["branch", "-M", "main"]);
	git(root, ["init", "--bare", remote]);
	git(seed, ["remote", "add", "origin", remote]);
	git(seed, ["push", "-u", "origin", "main"]);
	return { remote, seed };
}

function harness(project: string) {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const notices: Array<{ message: string; type?: string }> = [];
	const messages: any[] = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	let reloads = 0;
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		sendMessage(message: any) { messages.push(message); },
		async exec(command: string, args: string[], options: { cwd?: string } = {}) {
			const child = Bun.spawn([command, ...args], {
				cwd: options.cwd,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "Registry Test",
					GIT_AUTHOR_EMAIL: "registry@example.test",
					GIT_COMMITTER_NAME: "Registry Test",
					GIT_COMMITTER_EMAIL: "registry@example.test",
				},
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, code };
		},
	} as any;
	resourceRegistry(pi);
	const ctx = {
		cwd: project,
		hasUI: true,
		mode: "rpc",
		ui: {
			notify(message: string, type?: string) { notices.push({ message, type }); },
			setWidget(key: string, lines: string[] | undefined) { widgets.push({ key, lines }); },
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
		},
		reload: async () => { reloads += 1; },
	} as any;
	return { pi, commands, handlers, messages, notices, widgets, ctx, get reloads() { return reloads; } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous registry check");
		await Bun.sleep(10);
	}
}

describe("resource registry", () => {
	test("derives the same project key from SSH and HTTPS GitHub remotes", () => {
		expect(__test.projectKeyFromGitRemote("git@github.com:dnaroid/pi-ui-extend.git")).toBe("github.com__dnaroid__pi-ui-extend");
		expect(__test.projectKeyFromGitRemote("https://github.com/dnaroid/pi-ui-extend.git")).toBe("github.com__dnaroid__pi-ui-extend");
	});

	test("registers one /registry command", () => {
		const project = tempRoot();
		const { commands } = harness(project);
		expect([...commands.keys()]).toEqual(["registry"]);
	});

	test("reports an actionable error for a configured local registry that no longer exists", () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(path.join(home, ".config", "pi"), { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		const missingRemote = path.join(root, "deleted-registry.git");
		fs.writeFileSync(
			path.join(home, ".config", "pi", "pi-tools-suite.jsonc"),
			JSON.stringify({ resourceRegistry: { remote: missingRemote, branch: "main" } }),
		);

		expect(() => __test.loadRuntimeConfig(project)).toThrow(
			`Configured resource registry remote does not exist: ${missingRemote}. Run /registry configure <git-url> [branch] to replace it.`,
		);
	});

	test("publishes structured registry snapshots for the Desktop RPC manager", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		process.env.PIX_ACP_SESSION_STATE_BRIDGE = "1";
		const { remote } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		expect(fs.readFileSync(path.join(home, ".config", "pi", "pi-tools-suite.jsonc"), "utf8")).toContain(remote);
		await command.handler("rpc refresh", h.ctx);

		const refreshWidget = h.widgets.at(-1);
		expect(refreshWidget?.key).toBe("pix.session-state");
		expect(refreshWidget?.lines?.[0]).toBe("pi-tools-suite:resource-registry:state");
		const refresh = JSON.parse(refreshWidget?.lines?.[1] ?? "null");
		expect(refresh).toMatchObject({ configured: true, remote, branch: "main" });
		expect(refresh.items.find((item: any) => item.id === "skill:demo")).toMatchObject({
			type: "skill",
			status: "not-installed",
			statusLabel: "NOT INSTALLED",
			local: false,
			remote: true,
			actions: ["install", "remove"],
		});

		await command.handler("rpc install skill demo", h.ctx);
		const installed = JSON.parse(h.widgets.at(-1)?.lines?.[1] ?? "null");
		expect(installed.items.find((item: any) => item.id === "skill:demo")).toMatchObject({
			status: "up-to-date",
			statusLabel: "UP TO DATE",
			local: true,
			remote: true,
			actions: ["uninstall", "remove"],
		});
		expect(h.reloads).toBe(1);
	});

	test("serializes the startup Desktop snapshot with the Registry panel refresh", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		process.env.PIX_ACP_SESSION_STATE_BRIDGE = "1";
		const { remote } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");
		const exec = h.pi.exec.bind(h.pi);
		let activeDesktopClones = 0;
		let maxActiveDesktopClones = 0;

		h.pi.exec = async (gitCommand: string, args: string[], options: { cwd?: string } = {}) => {
			const desktopClone = gitCommand === "git"
				&& args[0] === "clone"
				&& args.at(-1)?.includes(`resource-registry-desktop-${process.pid}`);
			if (!desktopClone) return exec(gitCommand, args, options);
			activeDesktopClones += 1;
			maxActiveDesktopClones = Math.max(maxActiveDesktopClones, activeDesktopClones);
			try {
				await Bun.sleep(50);
				return await exec(gitCommand, args, options);
			} finally {
				activeDesktopClones -= 1;
			}
		};

		await command.handler(`configure ${remote} main`, h.ctx);
		const startupHandler = h.handlers.get("session_start")?.[0];
		expect(startupHandler).toBeDefined();
		startupHandler?.({ type: "session_start", reason: "reload" }, h.ctx);
		await command.handler("rpc refresh", h.ctx);
		await waitFor(() => h.widgets.length >= 2);

		const snapshots = h.widgets.slice(-2).map((widget) => JSON.parse(widget.lines?.[1] ?? "null"));
		expect(maxActiveDesktopClones).toBe(1);
		expect(snapshots).toHaveLength(2);
		expect(snapshots.every((snapshot) => snapshot?.configured === true && snapshot?.error === undefined)).toBe(true);
	});

	test("reuses the project registry snapshot across session starts", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		process.env.PIX_ACP_SESSION_STATE_BRIDGE = "1";
		const { remote } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");
		const exec = h.pi.exec.bind(h.pi);
		let fetches = 0;

		h.pi.exec = async (gitCommand: string, args: string[], options: { cwd?: string } = {}) => {
			if (gitCommand === "git" && args[0] === "fetch") fetches += 1;
			return exec(gitCommand, args, options);
		};

		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("rpc refresh", h.ctx);
		const fetchesAfterRefresh = fetches;
		expect(fetchesAfterRefresh).toBeGreaterThan(0);

		const startupHandler = h.handlers.get("session_start")?.[0];
		expect(startupHandler).toBeDefined();
		const widgetCount = h.widgets.length;
		startupHandler?.({ type: "session_start", reason: "reload" }, h.ctx);
		startupHandler?.({ type: "session_start", reason: "reload" }, h.ctx);
		await waitFor(() => h.widgets.length >= widgetCount + 2);

		expect(fetches).toBe(fetchesAfterRefresh);
		const latest = JSON.parse(h.widgets.at(-1)?.lines?.[1] ?? "null");
		expect(latest).toMatchObject({ configured: true, remote, branch: "main" });

		await command.handler("rpc refresh", h.ctx);
		expect(fetches).toBeGreaterThan(fetchesAfterRefresh);
	});

	test("drops a deferred Desktop registry snapshot after its session context becomes stale", async () => {
		const root = tempRoot();
		const project = path.join(root, "project");
		fs.mkdirSync(project, { recursive: true });
		process.env.PIX_ACP_SESSION_STATE_BRIDGE = "1";
		const h = harness(project);
		const ui = h.ctx.ui;
		let stale = false;
		const staleError = () => new Error(
			"This extension ctx is stale after session replacement or reload.",
		);
		const ctx = {
			get cwd() {
				if (stale) throw staleError();
				return project;
			},
			get mode() {
				if (stale) throw staleError();
				return "rpc";
			},
			get ui() {
				if (stale) throw staleError();
				return ui;
			},
			get hasUI() {
				if (stale) throw staleError();
				return true;
			},
		} as any;

		const startupHandler = h.handlers.get("session_start")?.[0];
		expect(startupHandler).toBeDefined();
		startupHandler?.({ type: "session_start", reason: "reload" }, ctx);
		stale = true;
		await Bun.sleep(50);
		expect(h.widgets).toHaveLength(0);
	});

	test("installs, detects updates, updates, and pushes skills/agents through Git", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const { remote, seed } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("install skill demo", h.ctx);
		await command.handler("install agent reviewer", h.ctx);

		expect(fs.readFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "utf8")).toContain("v1");
		expect(fs.readFileSync(path.join(project, ".pi", "agents", "reviewer.md"), "utf8")).toContain("Review carefully");
		expect(fs.existsSync(path.join(project, ".pi", "registry.json"))).toBe(true);
		expect(h.reloads).toBe(2);

		fs.writeFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "---\ndescription: Demo skill\n---\n\nv2\n");
		git(seed, ["add", "skills/demo/SKILL.md"]);
		git(seed, ["commit", "-m", "Update demo"]);
		git(seed, ["push", "origin", "main"]);

		const noticeCountBeforeStatus = h.notices.length;
		await command.handler("status", h.ctx);
		expect(h.notices).toHaveLength(noticeCountBeforeStatus);
		expect(h.messages.at(-1)).toMatchObject({
			customType: "pix-system",
			display: true,
			details: { kind: "resource-registry-status", userVisibleOnly: true },
		});
		expect(h.messages.at(-1)?.content).toContain("↓ demo  [SKILL]  **OUTDATED**");
		expect(h.messages.at(-1)?.content).toContain("✓ reviewer  [AGENT]  **UP TO DATE**");

		await command.handler("update skill demo", h.ctx);
		expect(fs.readFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "utf8")).toContain("v2");
		expect(h.reloads).toBe(3);

		fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(project, ".pi", "agents", "architect.md"),
			"---\ndescription: Architecture review\nmodels: [test/model]\n---\n\nReview architecture.\n",
		);
		await command.handler("push agent architect", h.ctx);

		expect(git(seed, ["pull", "--ff-only", "origin", "main"])).toContain("Updating");
		expect(fs.readFileSync(path.join(seed, "agents", "architect.md"), "utf8")).toContain("Architecture review");
		expect(h.notices.at(-1)?.message).toContain("Pushed agent \"architect\"");
		expect(h.reloads).toBe(4);
	});

	test("supports all for bulk install, update, push, remote remove, and local uninstall across skills and agents", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const { remote, seed } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("install all", h.ctx);

		expect(fs.existsSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"))).toBe(true);
		expect(fs.existsSync(path.join(project, ".pi", "agents", "reviewer.md"))).toBe(true);
		expect(h.reloads).toBe(1);

		fs.writeFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "---\ndescription: Demo skill\n---\n\nv2 bulk\n");
		fs.writeFileSync(path.join(seed, "agents", "reviewer.md"), "---\ndescription: Review code\nmodels: [test/model]\n---\n\nReview bulk v2.\n");
		git(seed, ["add", "skills/demo/SKILL.md", "agents/reviewer.md"]);
		git(seed, ["commit", "-m", "Bulk remote update"]);
		git(seed, ["push", "origin", "main"]);

		await command.handler("update all", h.ctx);
		expect(fs.readFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "utf8")).toContain("v2 bulk");
		expect(fs.readFileSync(path.join(project, ".pi", "agents", "reviewer.md"), "utf8")).toContain("Review bulk v2");
		expect(h.reloads).toBe(2);

		fs.mkdirSync(path.join(project, ".pi", "skills", "local-skill"), { recursive: true });
		fs.writeFileSync(path.join(project, ".pi", "skills", "local-skill", "SKILL.md"), "---\ndescription: Local skill\n---\n\nLocal skill body.\n");
		fs.writeFileSync(path.join(project, ".pi", "agents", "local-agent.md"), "---\ndescription: Local agent\nmodels: [test/model]\n---\n\nLocal agent body.\n");

		await command.handler("push all", h.ctx);
		git(seed, ["pull", "--ff-only", "origin", "main"]);

		expect(fs.readFileSync(path.join(seed, "skills", "local-skill", "SKILL.md"), "utf8")).toContain("Local skill body");
		expect(fs.readFileSync(path.join(seed, "agents", "local-agent.md"), "utf8")).toContain("Local agent body");
		expect(h.notices.at(-1)?.message).toContain("2 pushed, 2 unchanged, 0 failed");
		expect(h.reloads).toBe(3);

		await command.handler("remove all", h.ctx);
		git(seed, ["pull", "--ff-only", "origin", "main"]);

		expect(fs.existsSync(path.join(seed, "skills", "demo"))).toBe(false);
		expect(fs.existsSync(path.join(seed, "skills", "local-skill"))).toBe(false);
		expect(fs.existsSync(path.join(seed, "agents", "reviewer.md"))).toBe(false);
		expect(fs.existsSync(path.join(seed, "agents", "local-agent.md"))).toBe(false);
		expect(fs.existsSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"))).toBe(true);
		expect(fs.existsSync(path.join(project, ".pi", "agents", "reviewer.md"))).toBe(true);
		expect(fs.existsSync(path.join(project, ".pi", "skills", "local-skill", "SKILL.md"))).toBe(true);
		expect(fs.existsSync(path.join(project, ".pi", "agents", "local-agent.md"))).toBe(true);
		expect(h.notices.at(-1)?.message).toContain("Removed 4 registry resources");
		expect(h.reloads).toBe(4);

		await command.handler("uninstall all", h.ctx);
		expect(fs.existsSync(path.join(project, ".pi", "skills", "demo"))).toBe(false);
		expect(fs.existsSync(path.join(project, ".pi", "skills", "local-skill"))).toBe(false);
		expect(fs.existsSync(path.join(project, ".pi", "agents", "reviewer.md"))).toBe(false);
		expect(fs.existsSync(path.join(project, ".pi", "agents", "local-agent.md"))).toBe(false);
		expect(h.notices.at(-1)?.message).toContain("Uninstalled 4 local resources");
		expect(h.reloads).toBe(5);
	});

	test("pushes, reports, and pulls project-scoped tasks, plans, and TODO without mixing them with reusable resources", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(path.join(project, ".pi", "plans"), { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const { remote, seed } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("project-key project-alpha", h.ctx);
		fs.writeFileSync(path.join(project, ".pi", "tasks.jsonc"), '// keep this comment\n{"tasks":["local-v1"],}\n');
		fs.writeFileSync(path.join(project, ".pi", "plans", "roadmap.md"), "local plan v1\n");
		fs.writeFileSync(path.join(project, ".pi", "TODO.md"), "# TODO\n\n- local todo v1\n");

		await command.handler("push project", h.ctx);
		git(seed, ["pull", "--ff-only", "origin", "main"]);
		expect(fs.readFileSync(path.join(seed, "projects", "project-alpha", "tasks.jsonc"), "utf8")).toContain("// keep this comment");
		expect(fs.readFileSync(path.join(seed, "projects", "project-alpha", "plans", "roadmap.md"), "utf8")).toContain("local plan v1");
		expect(fs.readFileSync(path.join(seed, "projects", "project-alpha", "TODO.md"), "utf8")).toContain("local todo v1");
		expect(fs.existsSync(path.join(seed, "skills", "demo", "SKILL.md"))).toBe(true);

		fs.writeFileSync(path.join(seed, "projects", "project-alpha", "tasks.jsonc"), '{"tasks":["remote-v2"]}\n');
		fs.writeFileSync(path.join(seed, "projects", "project-alpha", "plans", "roadmap.md"), "remote plan v2\n");
		fs.writeFileSync(path.join(seed, "projects", "project-alpha", "TODO.md"), "# TODO\n\n- remote todo v2\n");
		git(seed, ["add", "projects/project-alpha"]);
		git(seed, ["commit", "-m", "Update project state"]);
		git(seed, ["push", "origin", "main"]);

		await command.handler("status", h.ctx);
		const updateStatus = h.messages.at(-1)?.content as string;
		expect(updateStatus).toContain("Project: project-alpha");
		expect(updateStatus).toContain("↓ tasks.jsonc  [PROJECT]  **OUTDATED**");
		expect(updateStatus).toContain("↓ plans/  [PROJECT]  **OUTDATED**");
		expect(updateStatus).toContain("↓ TODO.md  [PROJECT]  **OUTDATED**");
		const updateLines = updateStatus.split("\n").filter((line) => line.startsWith("↓ "));
		expect(updateLines).toEqual([...updateLines].sort((left, right) => {
			const leftName = left.split(" ")[1] ?? "";
			const rightName = right.split(" ")[1] ?? "";
			return leftName.localeCompare(rightName);
		}));

		const reloadsBeforePull = h.reloads;
		await command.handler("pull project", h.ctx);
		expect(fs.readFileSync(path.join(project, ".pi", "tasks.jsonc"), "utf8")).toContain("remote-v2");
		expect(fs.readFileSync(path.join(project, ".pi", "plans", "roadmap.md"), "utf8")).toContain("remote plan v2");
		expect(fs.readFileSync(path.join(project, ".pi", "TODO.md"), "utf8")).toContain("remote todo v2");
		expect(h.reloads).toBe(reloadsBeforePull + 1);

		fs.appendFileSync(path.join(project, ".pi", "tasks.jsonc"), "local change\n");
		fs.writeFileSync(path.join(seed, "projects", "project-alpha", "tasks.jsonc"), '{"tasks":["remote-v3"]}\n');
		git(seed, ["add", "projects/project-alpha/tasks.jsonc"]);
		git(seed, ["commit", "-m", "Update tasks again"]);
		git(seed, ["push", "origin", "main"]);

		await command.handler("status", h.ctx);
		expect(h.messages.at(-1)?.content).toContain("↕ tasks.jsonc  [PROJECT]  **CONFLICT**");
		await command.handler("pull tasks", h.ctx);
		expect(h.notices.at(-1)).toMatchObject({ type: "error" });
		expect(h.notices.at(-1)?.message).toContain("has local changes");
		expect(fs.readFileSync(path.join(project, ".pi", "tasks.jsonc"), "utf8")).toContain("local change");
	});

	test("treats an empty plans directory as removal of registry plans", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(path.join(project, ".pi", "plans"), { recursive: true });
		fs.writeFileSync(path.join(project, ".pi", "tasks.jsonc"), '{"tasks":["only"]}\n');
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const { remote, seed } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("project-key empty-plans", h.ctx);
		await command.handler("push project", h.ctx);
		git(seed, ["pull", "--ff-only", "origin", "main"]);
		expect(fs.existsSync(path.join(seed, "projects", "empty-plans", "tasks.jsonc"))).toBe(true);
		expect(fs.existsSync(path.join(seed, "projects", "empty-plans", "plans"))).toBe(false);

		await command.handler("push plans", h.ctx);
		expect(h.notices.at(-1)?.type).not.toBe("error");
		expect(h.notices.at(-1)?.message).toContain("already has no plans/");

		const localPlan = path.join(project, ".pi", "plans", "roadmap.md");
		fs.writeFileSync(localPlan, "roadmap v1\n");
		await command.handler("push plans", h.ctx);
		git(seed, ["pull", "--ff-only", "origin", "main"]);
		expect(fs.readFileSync(path.join(seed, "projects", "empty-plans", "plans", "roadmap.md"), "utf8")).toBe("roadmap v1\n");

		fs.rmSync(localPlan);
		await command.handler("push plans", h.ctx);
		git(seed, ["pull", "--ff-only", "origin", "main"]);
		expect(fs.existsSync(path.join(seed, "projects", "empty-plans", "plans"))).toBe(false);
		expect(h.notices.at(-1)?.type).not.toBe("error");

		const provenance = JSON.parse(fs.readFileSync(path.join(project, ".pi", "registry.json"), "utf8"));
		expect(provenance.projectResources.plans).toBeUndefined();
		await command.handler("status", h.ctx);
		expect(h.messages.at(-1)?.content).not.toContain("plans/");
	});

	test("removes a single remote resource, keeps the project copy, and reports removed-remote status", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const { remote, seed } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("install skill demo", h.ctx);
		const projectSkill = path.join(project, ".pi", "skills", "demo", "SKILL.md");
		expect(fs.existsSync(projectSkill)).toBe(true);

		await command.handler("delete skill demo", h.ctx);
		git(seed, ["pull", "--ff-only", "origin", "main"]);

		expect(fs.existsSync(path.join(seed, "skills", "demo"))).toBe(false);
		expect(fs.existsSync(projectSkill)).toBe(true);
		expect(h.notices.at(-1)?.message).toContain("Project copies were kept");
		expect(h.reloads).toBe(2);

		await command.handler("status", h.ctx);
		expect(h.messages.at(-1)?.content).toContain("× demo  [SKILL]  **REMOVED FROM REGISTRY**");
	});

	test("uninstalls a local resource, keeps the registry copy, clears provenance, and reloads", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const { remote, seed } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("install skill demo", h.ctx);
		expect(h.reloads).toBe(1);

		await command.handler("uninstall skill demo", h.ctx);
		expect(fs.existsSync(path.join(project, ".pi", "skills", "demo"))).toBe(false);
		expect(fs.existsSync(path.join(seed, "skills", "demo", "SKILL.md"))).toBe(true);
		expect(h.notices.at(-1)?.message).toContain("Registry copy was kept");
		expect(h.reloads).toBe(2);

		const provenance = JSON.parse(fs.readFileSync(path.join(project, ".pi", "registry.json"), "utf8"));
		expect(provenance.resources["skill:demo"]).toBeUndefined();

		await command.handler("status", h.ctx);
		expect(h.messages.at(-1)?.content).toContain("· demo  [SKILL]  **NOT INSTALLED**");
	});

	test("supports scoped bulk removal through the rm alias", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const { remote, seed } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("rm agents all", h.ctx);
		git(seed, ["pull", "--ff-only", "origin", "main"]);

		expect(fs.existsSync(path.join(seed, "agents", "reviewer.md"))).toBe(false);
		expect(fs.existsSync(path.join(seed, "skills", "demo", "SKILL.md"))).toBe(true);
	});

	test("offers remote removal through the registry TUI", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const { remote, seed } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		const selections = ["Remove", "Skills", "demo — Demo skill"];
		h.ctx.ui.select = async () => selections.shift();

		await command.handler("", h.ctx);
		git(seed, ["pull", "--ff-only", "origin", "main"]);

		expect(selections).toHaveLength(0);
		expect(fs.existsSync(path.join(seed, "skills", "demo"))).toBe(false);
		expect(fs.existsSync(path.join(seed, "agents", "reviewer.md"))).toBe(true);
		expect(h.reloads).toBe(1);
	});

	test("offers project-state push and pull through the registry TUI", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const { remote, seed } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("project-key tui-project", h.ctx);
		fs.writeFileSync(path.join(project, ".pi", "tasks.jsonc"), '{"tasks":["tui-v1"]}\n');
		let selections = ["Push project state", "Tasks"];
		h.ctx.ui.select = async () => selections.shift();
		await command.handler("", h.ctx);
		git(seed, ["pull", "--ff-only", "origin", "main"]);
		expect(fs.readFileSync(path.join(seed, "projects", "tui-project", "tasks.jsonc"), "utf8")).toContain("tui-v1");

		fs.writeFileSync(path.join(seed, "projects", "tui-project", "tasks.jsonc"), '{"tasks":["tui-v2"]}\n');
		git(seed, ["add", "projects/tui-project/tasks.jsonc"]);
		git(seed, ["commit", "-m", "Update TUI tasks"]);
		git(seed, ["push", "origin", "main"]);
		selections = ["Pull project state", "Tasks"];
		await command.handler("", h.ctx);
		expect(fs.readFileSync(path.join(project, ".pi", "tasks.jsonc"), "utf8")).toContain("tui-v2");
	});

	test("checks for registry updates asynchronously on application startup and warns only when needed", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const { remote, seed } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("install skill demo", h.ctx);
		h.notices.splice(0);

		fs.writeFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "---\ndescription: Demo skill\n---\n\nv2\n");
		git(seed, ["add", "skills/demo/SKILL.md"]);
		git(seed, ["commit", "-m", "Startup update"]);
		git(seed, ["push", "origin", "main"]);

		const startupHandler = h.handlers.get("session_start")?.[0];
		expect(startupHandler).toBeDefined();
		expect(startupHandler?.({ type: "session_start", reason: "startup" }, h.ctx)).toBeUndefined();
		await waitFor(() => h.notices.some((notice) => notice.type === "warning"));

		const warning = h.notices.find((notice) => notice.type === "warning");
		expect(warning?.message).toContain("1 update available");
		expect(warning?.message).toContain("/registry status");

		const warningCount = h.notices.filter((notice) => notice.type === "warning").length;
		startupHandler?.({ type: "session_start", reason: "reload" }, h.ctx);
		await Bun.sleep(50);
		expect(h.notices.filter((notice) => notice.type === "warning")).toHaveLength(warningCount);
	});

	test("startup check warns when project-scoped state is available remotely but missing locally", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const { remote, seed } = createRegistry(root);
		fs.mkdirSync(path.join(seed, "projects", "project-alpha"), { recursive: true });
		fs.writeFileSync(path.join(seed, "projects", "project-alpha", "tasks.jsonc"), '{"tasks":["remote"]}\n');
		git(seed, ["add", "projects/project-alpha/tasks.jsonc"]);
		git(seed, ["commit", "-m", "Add project tasks"]);
		git(seed, ["push", "origin", "main"]);

		const h = harness(project);
		const command = h.commands.get("registry");
		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("project-key project-alpha", h.ctx);
		h.notices.splice(0);

		const startupHandler = h.handlers.get("session_start")?.[0];
		startupHandler?.({ type: "session_start", reason: "startup" }, h.ctx);
		await waitFor(() => h.notices.some((notice) => notice.type === "warning"));
		expect(h.notices.find((notice) => notice.type === "warning")?.message).toContain("1 update available");
	});

	test("bootstraps the configured branch when the private registry repository is empty", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		const remote = path.join(root, "empty-registry.git");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(path.join(project, ".pi", "skills", "first"), { recursive: true });
		fs.writeFileSync(
			path.join(project, ".pi", "skills", "first", "SKILL.md"),
			"---\ndescription: First resource\n---\n\nBootstrap.\n",
		);
		git(root, ["init", "--bare", remote]);
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("push skill first", h.ctx);

		expect(git(root, ["--git-dir", remote, "show", "main:skills/first/SKILL.md"])).toContain("Bootstrap");
		expect(h.notices.at(-1)?.message).toContain("Pushed skill \"first\"");
	});

	test("status marks simultaneous local and remote edits as diverged and update refuses to overwrite", async () => {
		const root = tempRoot();
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.XDG_CACHE_HOME = path.join(root, "cache");
		const { remote, seed } = createRegistry(root);
		const h = harness(project);
		const command = h.commands.get("registry");

		await command.handler(`configure ${remote} main`, h.ctx);
		await command.handler("install skill demo", h.ctx);
		fs.appendFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "local change\n");
		fs.appendFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "remote change\n");
		git(seed, ["add", "skills/demo/SKILL.md"]);
		git(seed, ["commit", "-m", "Remote change"]);
		git(seed, ["push", "origin", "main"]);

		const noticeCountBeforeStatus = h.notices.length;
		await command.handler("status", h.ctx);
		expect(h.notices).toHaveLength(noticeCountBeforeStatus);
		expect(h.messages.at(-1)?.content).toContain("↕ demo  [SKILL]  **CONFLICT**");
		await command.handler("update skill demo", h.ctx);
		expect(h.notices.at(-1)).toMatchObject({ type: "error" });
		expect(h.notices.at(-1)?.message).toContain("has local changes");
		expect(fs.readFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "utf8")).toContain("local change");
	});
});
