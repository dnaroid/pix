import { describe, expect, it } from "vitest";
import {
  projectColorFromWorkspaceConfig,
  projectIconPathFromWorkspaceConfig,
  workspaceConfigWithProjectSettings,
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

  it("reads only canonical project logo paths", () => {
    expect(projectIconPathFromWorkspaceConfig('{"icon":".pi/project-icon.png"}')).toBe(".pi/project-icon.png");
    expect(projectIconPathFromWorkspaceConfig('{"icon":".pi/project-icon.svg"}')).toBe(".pi/project-icon.svg");
    expect(projectIconPathFromWorkspaceConfig('{"icon":"../secret.png"}')).toBeUndefined();
    expect(projectIconPathFromWorkspaceConfig('{"icon":".pi/workspace.jsonc"}')).toBeUndefined();
    expect(projectIconPathFromWorkspaceConfig("{")).toBeUndefined();
  });

  it("updates or preserves the logo independently of the color", () => {
    const withIcon = workspaceConfigWithProjectSettings('{ // keep\n "color": "#123" }', {
      color: "#123", icon: ".pi/project-icon.png",
    });
    expect(withIcon).toContain("// keep");
    expect(projectIconPathFromWorkspaceConfig(withIcon)).toBe(".pi/project-icon.png");
    const kept = workspaceConfigWithProjectSettings(withIcon, { color: undefined });
    expect(projectIconPathFromWorkspaceConfig(kept)).toBe(".pi/project-icon.png");
    expect(projectColorFromWorkspaceConfig(kept)).toBeUndefined();
    const removed = workspaceConfigWithProjectSettings(kept, { color: undefined, icon: undefined });
    expect(projectIconPathFromWorkspaceConfig(removed)).toBeUndefined();
    expect(() => workspaceConfigWithProjectSettings("{}", { color: undefined, icon: "/etc/passwd" })).toThrow();
  });
});
