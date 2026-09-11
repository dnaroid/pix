import { describe, expect, it } from "vitest";
import {
  projectColorFromWorkspaceConfig,
  workspaceConfigWithProjectColor,
  WORKSPACE_CONFIG_PATH,
} from "./project-colors";

describe("workspace project color", () => {
  it("uses a workspace-local JSONC file", () => {
    expect(WORKSPACE_CONFIG_PATH).toBe(".pi/workspace.jsonc");
    expect(projectColorFromWorkspaceConfig(`{
      // Stable project identity color.
      "color": "#7aa2f7",
    }`)).toBe("#7aa2f7");
  });

  it("accepts common hex color forms", () => {
    expect(projectColorFromWorkspaceConfig('{"color":"#abc"}')).toBe("#abc");
    expect(projectColorFromWorkspaceConfig('{"color":"#abcd"}')).toBe("#abcd");
    expect(projectColorFromWorkspaceConfig('{"color":"#AABBCC"}')).toBe("#AABBCC");
    expect(projectColorFromWorkspaceConfig('{"color":"#AABBCCDD"}')).toBe("#AABBCCDD");
  });

  it("falls back for malformed config or unsupported values", () => {
    expect(projectColorFromWorkspaceConfig(undefined)).toBeUndefined();
    expect(projectColorFromWorkspaceConfig("{")).toBeUndefined();
    expect(projectColorFromWorkspaceConfig('{"color":"blue"}')).toBeUndefined();
    expect(projectColorFromWorkspaceConfig('{"color":42}')).toBeUndefined();
  });

  it("updates only the color field while preserving JSONC comments and sibling settings", () => {
    const next = workspaceConfigWithProjectColor(`{
  // Project-local settings.
  "name": "Pix",
  "color": "#112233",
}\n`, "#7aa2f7");
    expect(next).toContain("// Project-local settings.");
    expect(next).toContain('"name": "Pix"');
    expect(projectColorFromWorkspaceConfig(next)).toBe("#7aa2f7");
  });

  it("can reset the override without replacing the rest of the workspace config", () => {
    const next = workspaceConfigWithProjectColor('{"name":"Pix","color":"#112233"}', undefined);
    expect(next).toContain('"name": "Pix"');
    expect(projectColorFromWorkspaceConfig(next)).toBeUndefined();
  });

  it("refuses to overwrite malformed workspace config", () => {
    expect(() => workspaceConfigWithProjectColor("{", "#112233")).toThrow("workspace.jsonc is malformed");
  });
});
