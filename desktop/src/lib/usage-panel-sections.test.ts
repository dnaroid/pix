import { describe, expect, it } from "vitest";
import { usageCollapsedSections, usageProviderOrder, workspaceConfigWithUsageProviderOrder, workspaceConfigWithUsageSection } from "./usage-panel-sections";

describe("usage panel workspace config", () => {
  it("preserves JSONC comments, sibling settings and stable section ids", () => {
    const source = '// project\n{ "color": "#112233", "usagePanel": { "future": true } }\n';
    const collapsed = workspaceConfigWithUsageSection(source, "daily", false);
    expect(collapsed).toContain("// project");
    expect(collapsed).toContain('"color": "#112233"');
    expect(collapsed).toContain('"future": true');
    expect(usageCollapsedSections(collapsed)).toEqual(["daily"]);
    const more = workspaceConfigWithUsageSection(collapsed, "activity", false);
    const opened = workspaceConfigWithUsageSection(more, "daily", true);
    expect(usageCollapsedSections(opened)).toEqual(["activity"]);
  });

  it("starts from a missing file and keeps unrelated/unknown section ids", () => {
    expect(usageCollapsedSections(undefined)).toEqual([]);
    expect(usageCollapsedSections(workspaceConfigWithUsageSection(undefined, "overview", false))).toEqual(["overview"]);
    const source = '{"usagePanel":{"collapsedSections":["future","daily","daily"]}}';
    expect(usageCollapsedSections(workspaceConfigWithUsageSection(source, "daily", true))).toEqual(["future"]);
  });

  it("stores provider order without losing comments, collapsed ids or future providers", () => {
    const source = '// project\n{ "color": "#112233", "usagePanel": { "collapsedSections": ["daily"], "future": true } }';
    expect(usageProviderOrder(undefined)).toEqual([]);
    const ordered = workspaceConfigWithUsageProviderOrder(source, ["openai", "zhipu", "future", "openai"]);
    expect(ordered).toContain("// project");
    expect(ordered).toContain('"color": "#112233"');
    expect(ordered).toContain('"future": true');
    expect(usageProviderOrder(ordered)).toEqual(["openai", "zhipu", "future"]);
    expect(usageCollapsedSections(ordered)).toEqual(["daily"]);
    expect(usageProviderOrder(workspaceConfigWithUsageSection(ordered, "daily", true))).toEqual(["openai", "zhipu", "future"]);
    expect(usageProviderOrder(workspaceConfigWithUsageProviderOrder(undefined, ["anthropic"]))).toEqual(["anthropic"]);
  });

  it.each(["{", "[]", '{"usagePanel":false}', '{"usagePanel":{"collapsedSections":"bad"}}', '{"usagePanel":{"collapsedSections":[1]}}', '{"usagePanel":{"providerOrder":false}}', '{"usagePanel":{"providerOrder":[1]}}'])
    ("refuses to overwrite malformed or invalid configuration: %s", (source) => {
      expect(() => workspaceConfigWithUsageSection(source, "overview", false)).toThrow(".pi/workspace.jsonc");
      expect(() => workspaceConfigWithUsageProviderOrder(source, ["openai"])).toThrow(".pi/workspace.jsonc");
    });
});
