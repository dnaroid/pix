import { describe, expect, it } from "vitest";
import source from "./DesktopTitlebar.svelte?raw";

describe("DesktopTitlebar restart action", () => {
  it("uses a compact danger treatment instead of the primary accent", () => {
    const restart = source.slice(source.indexOf("{#if restartAvailable}"), source.indexOf("</button>", source.indexOf("{#if restartAvailable}")));
    expect(restart).toContain("h-6 w-6");
    expect(restart).toContain("bg-tool-error/10 text-tool-error hover:bg-tool-error/20");
    expect(restart).not.toContain("bg-primary");
    expect(restart).toContain('"h-3.5 w-3.5"');
    expect(restart).toContain("disabled={restartPending}");
    expect(restart).toContain("onclick={onRestart}");
    expect(restart).toContain("focus-visible:outline-ring");
  });
});
