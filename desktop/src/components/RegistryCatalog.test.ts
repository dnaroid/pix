import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import RegistryCatalog from "./RegistryCatalog.svelte";
import type { RegistrySnapshot } from "../lib/registry";

const contextCommands = ["pdf", "context7", "simplify"].map((name) => ({
  name: `skill:${name}`, description: `${name} session description`,
  _meta: { "pix.commandSource": "skill" },
}));

function catalog(snapshot?: RegistrySnapshot, loading = false, commands = contextCommands): string {
  return render(RegistryCatalog, { props: {
    snapshot, loading, contextCommands: commands,
    remoteDisabled: false, actionId: null, diff: undefined,
    onAction: () => {}, onDiff: () => {},
  } }).body;
}

describe("RegistryCatalog session skills", () => {
  it("renders all session skills even when only one is in the Registry", () => {
    const html = catalog({
      version: 1, configured: true, branch: "main", checkedAt: "now",
      items: [{
        id: "skill:pdf", type: "skill", name: "pdf", status: "not-installed",
        statusLabel: "NOT INSTALLED", icon: "·", local: false, remote: true, actions: ["install"],
      }],
    });
    for (const name of ["pdf", "context7", "simplify"]) {
      expect(html).toContain(`title="${name}"`);
    }
    expect(html.match(/>In context</g)).toHaveLength(3);
    expect(html.match(/>External</g)).toHaveLength(2);
    expect(html).toContain('title="Available to the active session; not managed by Registry."');
    expect(html.match(/Published · Global/g)).toHaveLength(1);
    expect(html).not.toContain("Local only");
    expect(html).not.toContain("Only in this project");
    expect(html).not.toContain("Install here");
  });

  it.each([false, true])("renders session-only skills before Registry data arrives (loading=%s)", (loading) => {
    const html = catalog(undefined, loading);
    expect(html.match(/>In context</g)).toHaveLength(3);
    expect(html.match(/>External</g)).toHaveLength(3);
    expect(html).toContain("context7 session description");
    expect(html).not.toContain("Registry data is not loaded yet");
    expect(html).not.toContain("Checking registry…");
    expect(html).not.toContain("Published ·");
    expect(html).not.toContain("Only in this project");
    expect(html).not.toContain("More actions");
  });

  it("does not retain session-only skills when the session command list is cleared", () => {
    const html = catalog(undefined, false, []);
    expect(html).not.toContain(">In context<");
    expect(html).not.toContain(">External<");
    expect(html).toContain("Registry data is not loaded yet");
  });

  it("does not mark Registry-managed project copies as external", () => {
    const html = catalog({
      version: 1, configured: false, branch: "main", checkedAt: "now",
      items: contextCommands.map((command) => ({
        id: command.name, type: "skill", name: command.name.replace("skill:", ""),
        status: "local-only", statusLabel: "LOCAL", icon: "·",
        local: true, remote: false, actions: [],
      })),
    });
    expect(html.match(/>In context</g)).toHaveLength(3);
    expect(html).not.toContain(">External<");
    expect(html).not.toContain("not managed by Registry");
  });
});
