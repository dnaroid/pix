import { describe, expect, it } from "vitest";
import lifecycleServicesSource from "./desktop-lifecycle-services.ts?raw";
import workspaceServicesSource from "./desktop-workspace-services.ts?raw";

describe("project .pi auto-clean startup wiring", () => {
  it("starts background TTL cleanup when restoring the current project", () => {
    expect(lifecycleServicesSource).toContain(
      "void options.projectServices.registry.autoCleanProject(workspace)",
    );
  });

  it("starts background TTL cleanup when switching projects", () => {
    expect(workspaceServicesSource).toContain(
      "void options.project.registry.autoCleanProject(selected)",
    );
  });
});
