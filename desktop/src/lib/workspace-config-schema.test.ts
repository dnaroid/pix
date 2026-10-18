import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { workspaceConfigWithProjectColor } from "./project-colors";
import { workspaceConfigWithProjectExplorerExpandedDirectories } from "./project-explorer-expansion";
import { workspaceConfigWithLaunchCommands } from "./project-launch-commands";
import { workspaceConfigWithUsageSection } from "./usage-panel-sections";
import { WORKSPACE_SCHEMA_URL } from "./workspace-config-schema";

const writers = [
  (source: string | undefined) => workspaceConfigWithProjectColor(source, "#abc"),
  (source: string | undefined) => workspaceConfigWithProjectExplorerExpandedDirectories(source, ["src"]),
  (source: string | undefined) => workspaceConfigWithLaunchCommands(source, [{ id: "dev", name: "Dev", command: "npm run dev" }]),
  (source: string | undefined) => workspaceConfigWithUsageSection(source, "daily", false),
];

describe.each(writers)("workspace schema metadata (%#)", (write) => {
  it.each([undefined, "", "  ", "{}"])("adds a schema to new configurations: %s", (source) => {
    expect(parse(write(source)).$schema).toBe(WORKSPACE_SCHEMA_URL);
  });

  it("upgrades existing JSONC without losing comments or unknown fields", () => {
    const next = write('{ // keep\n "future": { "enabled": true }, }');
    expect(next).toContain("// keep");
    expect(parse(next)).toMatchObject({ $schema: WORKSPACE_SCHEMA_URL, future: { enabled: true } });
    expect(write(next)).toBe(next);
    expect(next.endsWith("\n")).toBe(true);
  });

  it("preserves an explicit custom schema", () => {
    expect(parse(write('{"$schema":"./custom.json"}')).$schema).toBe("./custom.json");
  });
});
