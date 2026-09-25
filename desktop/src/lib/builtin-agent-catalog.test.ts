import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_CATALOG } from "./builtin-agent-catalog.js";

describe("built-in agent catalog", () => {
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
