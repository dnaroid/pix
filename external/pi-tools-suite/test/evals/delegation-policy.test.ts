import { expect, test } from "bun:test";
import { DELEGATION_POLICY_CASES, validateDelegationRole } from "./delegation-policy.js";
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

test("delegation cases are model-independent and include negative controls", () => {
	expect(DELEGATION_POLICY_CASES).toHaveLength(5);
	for (const scenario of DELEGATION_POLICY_CASES) {
		expect(scenario.models).toBeUndefined();
		expect(scenario.appendSystemPrompt).toContain("duplicated context, briefing and integration");
	}
	expect(DELEGATION_POLICY_CASES.filter((scenario) => scenario.assert.forbiddenTools?.includes("subagents"))).toHaveLength(2);
});
