import { describe, expect, it } from "vitest";
import Bot from "@lucide/svelte/icons/bot";
import Search from "@lucide/svelte/icons/search";
import Terminal from "@lucide/svelte/icons/terminal";
import { agentIcon } from "./agent-icons";

describe("desktop agent icons", () => {
  it("resolves known agent icon names to their lucide components", () => {
    expect(agentIcon("search")).toBe(Search);
    expect(agentIcon("terminal")).toBe(Terminal);
  });

  it("falls back to the neutral bot for missing or unknown names", () => {
    expect(agentIcon(undefined)).toBe(Bot);
    expect(agentIcon("")).toBe(Bot);
    expect(agentIcon("  ")).toBe(Bot);
    expect(agentIcon("does-not-exist")).toBe(Bot);
  });
});
