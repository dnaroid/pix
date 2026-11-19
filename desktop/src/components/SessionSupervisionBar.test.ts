import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import SessionSupervisionBar from "./SessionSupervisionBar.svelte";
import type { SupervisionState } from "../lib/session-supervision";

function bar(mode: SupervisionState["mode"], enabled = true, supervisorAvailable = true) {
  return render(SessionSupervisionBar, { props: {
    supervision: { mode, enabled, supervisorAvailable }, onSetSupervised() {},
  } }).body;
}

describe("SessionSupervisionBar", () => {
  it("renders no header for an ordinary session", () => {
    expect(bar(undefined)).not.toContain("<button");
    expect(bar(undefined)).not.toContain("Hand Over to Supervisor");
    expect(bar(undefined, true, false)).not.toContain("<button");
  });

  it("lets the user take back a managed session or hand it over again after manual takeover", () => {
    expect(bar("managed")).toContain("Supervisor managed");
    expect(bar("managed")).toContain("Take Back from Supervisor");
    expect(bar("managed")).not.toContain("Hand Over to Supervisor");
    const manual = bar("manual", false);
    expect(manual).toContain("Manual control");
    expect(manual).toContain("Hand Over to Supervisor");
    expect(manual).toContain("Take Back from Supervisor");
    expect(manual.match(/<button[^>]*\sdisabled(?=[\s=>])/gu)).toHaveLength(2);
  });
});
