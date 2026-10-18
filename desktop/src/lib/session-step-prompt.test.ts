import { describe, expect, it } from "vitest";
import { buildSessionStepRerunPrompt } from "./session-step-prompt";

describe("buildSessionStepRerunPrompt", () => {
  it("names one step, includes details and scopes the rerun to it", () => {
    const text = buildSessionStepRerunPrompt({ id: 3, subject: "Fix parser", description: "  Handle CRLF  " });
    expect(text).toContain("Rerun session step #3: Fix parser");
    expect(text).toContain("Step details: Handle CRLF");
    expect(text).toContain("Redo only this step");
    expect(text).toContain("mark step #3 in_progress");
    expect(buildSessionStepRerunPrompt({ id: 1, subject: "A" })).not.toContain("Step details");
  });
});
