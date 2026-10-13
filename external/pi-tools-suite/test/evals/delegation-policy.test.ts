import { expect, test } from "bun:test";
import { DELEGATION_POLICY_CASES, validateDelegationRole, validateOracleBudget } from "./delegation-policy.js";
import type { EvalRunResult } from "./harness/types.js";

function result(input: unknown): EvalRunResult {
	return { events: [{ type: "tool_call", toolName: "subagents", input }] } as EvalRunResult;
}

test("selection validator rejects retired roles, omitted roles, status calls and extra workers", () => {
	expect(validateDelegationRole(result({ action: "spawn", tasks: [{ subagentType: "implement-core" }] }), "implement-core")).toEqual([]);
	for (const input of [
		{ action: "spawn", tasks: [{ subagentType: "implement" }] },
		{ action: "spawn", tasks: [{}] },
		{ action: "status", tasks: [{ subagentType: "implement-core" }] },
		{ action: "spawn", tasks: [{ subagentType: "implement-core" }, { subagentType: "research" }] },
		{},
	]) expect(validateDelegationRole(result(input), "implement-core").length).toBeGreaterThan(0);
	expect(validateDelegationRole({ events: [] } as unknown as EvalRunResult, "implement-core").length).toBeGreaterThan(0);
});

test("oracle budget validator rejects spawn-level and task-level watchdog overrides", () => {
	expect(validateOracleBudget(result({ action: "spawn", tasks: [{ subagentType: "oracle" }] }))).toEqual([]);
	for (const input of [
		{ action: "spawn", timeoutSeconds: 300, tasks: [{ subagentType: "oracle" }] },
		{ action: "spawn", tasks: [{ subagentType: "oracle", timeoutSeconds: 600 }] },
		{ action: "spawn", timeoutSeconds: 1800, tasks: [{ subagentType: "oracle" }] },
		{ action: "spawn", tasks: [{ subagentType: "research" }] },
	]) expect(validateOracleBudget(result(input)).length).toBeGreaterThan(0);
	const scenario = DELEGATION_POLICY_CASES.find((entry) => entry.id === "orchestration.architecture-advice-first")!;
	expect(scenario.validate).toBe(validateOracleBudget);
	expect(scenario.blockTools).toContain("subagents");
});

test("delegation cases are model-independent and include negative controls", () => {
	expect(DELEGATION_POLICY_CASES).toHaveLength(5);
	for (const scenario of DELEGATION_POLICY_CASES) {
		expect(scenario.models).toBeUndefined();
		expect(scenario.appendSystemPrompt).toContain("duplicated context, briefing and integration");
	}
	expect(DELEGATION_POLICY_CASES.filter((scenario) => scenario.assert.forbiddenTools?.includes("subagents"))).toHaveLength(2);
});
