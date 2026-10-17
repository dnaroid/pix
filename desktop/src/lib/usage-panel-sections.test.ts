import { describe, expect, it } from "vitest";
import { usageCollapsedSections, workspaceConfigWithUsageSection } from "./usage-panel-sections";

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

  it.each(["{", "[]", '{"usagePanel":false}', '{"usagePanel":{"collapsedSections":"bad"}}', '{"usagePanel":{"collapsedSections":[1]}}'])
    ("refuses to overwrite malformed or invalid configuration: %s", (source) => {
      expect(() => workspaceConfigWithUsageSection(source, "overview", false)).toThrow(".pi/workspace.jsonc");
    });
});
