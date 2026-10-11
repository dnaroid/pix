import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSubagentConfig, resolveAgentTaskConfig } from "../../src/async-subagents/core/config.js";
import { buildSubagentCatalogPrompt } from "../../src/async-subagents/core/agent-catalog.js";
import { routeSubagentTasks } from "../../src/async-subagents/core/routing.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

for (const name of ["implement", "delivery-review"]) {
	test(`${name} is absent by default, rejected without alias, and available as an explicit project role`, async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "retired-role-"));
		dirs.push(cwd);
		const config = loadSubagentConfig(cwd, {});
		expect(config.types[name]).toBeUndefined();
		expect(buildSubagentCatalogPrompt(config)).not.toContain(`- ${name}:`);
		const tasks = [{ id: "chosen", task: "Explicit user handoff", subagentType: name }];
		await expect(routeSubagentTasks(tasks, config, {})).rejects.toThrow(/Unknown subagentType/);
		// An omitted task must not rescue a retired explicit role in a mixed batch.
		await expect(routeSubagentTasks([...tasks, { id: "auto", task: "Gather evidence" }], config, {}))
			.rejects.toThrow(/Unknown subagentType/);

		const agents = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(agents, { recursive: true });
		fs.writeFileSync(path.join(agents, `${name}.md`), "---\ndescription: Local specialist\nmodels: [test/local]\ntools: [read]\n---\nLocal contract only.\n");
		const local = loadSubagentConfig(cwd, {});
		local.routing = { enabled: false };
		expect(buildSubagentCatalogPrompt(local)).toContain(`- ${name}: Local specialist`);
		expect(await routeSubagentTasks(tasks, local, {})).toMatchObject({ tasks, usedLlm: false });
		const resolved = resolveAgentTaskConfig(tasks[0]!, local);
		expect(resolved.task.model).toBe("test/local");
		expect(resolved.task.tools).toEqual(["read"]);
		expect(local.types[name].promptAppend).toBe("Local contract only.");
	});
}
