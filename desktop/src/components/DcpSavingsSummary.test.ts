import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import DcpSavingsSummary from "./DcpSavingsSummary.svelte";

describe("DCP savings summary", () => {
  it("shows zero savings neutrally without a success claim or green styling", () => {
    const html = render(DcpSavingsSummary, { props: { tokensSaved: 0 } }).body;
    expect(html).toContain("DCP savings");
    expect(html).toContain("~0 tokens");
    expect(html).toContain("border-border text-muted-foreground");
    expect(html).not.toContain("DCP saved you");
    expect(html).not.toContain("tool-success");
  });

  it("celebrates positive savings and keeps the compact estimate", () => {
    for (const [tokensSaved, expected] of [[1, "1"], [168_486, "168K"]] as const) {
      const html = render(DcpSavingsSummary, { props: { tokensSaved } }).body;
      expect(html).toContain("DCP saved you");
      expect(html).toContain(`~${expected} tokens`);
      expect(html).toContain("border-tool-success/30 bg-tool-success/10 text-tool-success");
    }
  });
});
