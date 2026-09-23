import { describe, expect, it } from "vitest";
import bootstrapSource from "./DesktopBootstrapDialog.svelte?raw";

describe("DesktopBootstrapDialog", () => {
  it("keeps first-run setup visible on Escape and completes only through Continue", () => {
    expect(bootstrapSource).toContain("function retainUntilContinue(event: Event): void {");
    expect(bootstrapSource).toContain("event.preventDefault();");
    expect(bootstrapSource).toContain("oncancel={retainUntilContinue}");
    expect(bootstrapSource).not.toContain("oncancel={(event) => { event.preventDefault(); finish(); }}");
    expect(bootstrapSource).toContain("onclick={finish}");
    expect(bootstrapSource).toContain("disabled={busy !== null}");
  });
});
