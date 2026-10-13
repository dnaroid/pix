import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_CATALOG, builtinAgentDefaultModel } from "./builtin-agent-catalog.js";

describe("built-in agent catalog", () => {
  it("reads primary models but excludes automatic/frontier profiles", () => {
    for (const agent of BUILTIN_AGENT_CATALOG) {
      if (agent.name === "oracle") expect(agent.defaultModel).toBeUndefined();
      else expect(agent.defaultModel).toMatch(/^[^\s/]+\/[^\s]+$/u);
    }
    expect(builtinAgentDefaultModel('---\nmodels: ["provider/model:high", fallback/model]\n---\nBody')).toBe("provider/model:high");
    expect(builtinAgentDefaultModel("---\nmodels: [openrouter/vendor/model:high, fallback/model]\n---\nBody")).toBe("openrouter/vendor/model:high");
    expect(builtinAgentDefaultModel("---\nmodels:\n  - 'provider/model'\n  - fallback/model\n---\nBody")).toBe("provider/model");
    expect(builtinAgentDefaultModel("---\nmodel: legacy/model\n---\nBody")).toBe("legacy/model");
    expect(builtinAgentDefaultModel("---\nmodelSelection: frontier\nmodel: ignored/model\n---\nBody")).toBeUndefined();
    expect(builtinAgentDefaultModel("models: [not/frontmatter]")).toBeUndefined();
  });
  it("discovers bundled markdown definitions and reads display metadata", () => {
    expect(BUILTIN_AGENT_CATALOG.map((agent) => agent.name)).toContain("research");
    expect(BUILTIN_AGENT_CATALOG.find((agent) => agent.name === "research")).toMatchObject({
      icon: "search",
    });
    expect(BUILTIN_AGENT_CATALOG.find((agent) => agent.name === "ui-qa")).toMatchObject({
      icon: "bug",
    });
    expect(BUILTIN_AGENT_CATALOG.find((agent) => agent.name === "delivery-review")?.icon).toBeUndefined();
    expect(BUILTIN_AGENT_CATALOG.map((agent) => agent.name)).toEqual(
      [...BUILTIN_AGENT_CATALOG.map((agent) => agent.name)].sort((left, right) => left.localeCompare(right)),
    );
  });
});
