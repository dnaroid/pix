import { describe, expect, it } from "vitest";
import projectServicesSource from "../app/desktop-project-services.ts?raw";
import sectionSource from "./GitCiSection.svelte?raw";

describe("Git CI setup UI", () => {
  it("shows copyable install/auth guidance with provider documentation links", () => {
    expect(sectionSource).toContain("gitCiSetupGuide(ci.snapshot)");
    expect(sectionSource).toContain("writeText(command)");
    expect(sectionSource).toContain("Installation guide");
    expect(sectionSource).toContain("Authentication guide");
    expect(sectionSource).toContain("After setup completes, use Refresh to retry CI detection.");
  });

  it("refreshes Git state when the native CI target reports a changed HEAD", () => {
    expect(projectServicesSource).toContain("onTargetStale: () => void git.refresh()");
  });
});
