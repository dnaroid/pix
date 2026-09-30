import { describe, expect, it } from "vitest";
import { registryCardActions, registryMenuPosition } from "./registry-card-actions";
import { registryDiffAvailable, type RegistryItem, type RegistryItemAction } from "./registry";

function item(actions: RegistryItemAction[], status: RegistryItem["status"] = "up-to-date"): RegistryItem {
  return { id: "skill:demo", name: "demo", type: "skill", local: true, remote: true,
    status, statusLabel: status, icon: "", actions };
}

describe("Registry card action partition", () => {
  it.each(["install", "update", "push", "pull"] as const)("keeps %s visible without promoting maintenance commands", (action) => {
    const resource = item(["tags", "toggle-scope", action, "make-local", "uninstall", "remove"]);
    expect(registryCardActions(resource)).toEqual({
      primary: action, secondary: ["tags", "toggle-scope", "make-local", "uninstall", "remove"],
    });
    expect(resource.actions).toHaveLength(6);
  });
  it("keeps alternate conflict resolution reachable in overflow and Compare visible", () => {
    const resource = item(["push", "pull", "tags", "uninstall", "remove"], "diverged");
    expect(registryCardActions(resource)).toEqual({ primary: "push", secondary: ["pull", "tags", "uninstall", "remove"] });
    expect(registryDiffAvailable(resource)).toBe(true);
  });
  it("shows only overflow for synced or context-only resources with maintenance actions", () => {
    expect(registryCardActions(item(["tags", "toggle-scope", "make-local", "uninstall", "remove"])).primary).toBeUndefined();
    expect(registryCardActions({ ...item(["toggle-scope", "remove"]), local: false, inContext: true })).toEqual({
      primary: undefined, secondary: ["toggle-scope", "remove"],
    });
  });
  it("has no overflow when only a routine action is available", () => {
    expect(registryCardActions(item(["install"]))).toEqual({ primary: "install", secondary: [] });
    expect(registryCardActions(item([]))).toEqual({ primary: undefined, secondary: [] });
  });
});

describe("Registry menu viewport placement", () => {
  it("aligns to the trigger's right edge below the card", () => {
    expect(registryMenuPosition({ right: 350, top: 80, bottom: 100 }, 240, 160, 800, 600)).toEqual({ left: 110, top: 104 });
  });
  it("flips above a bottom row and clamps horizontal overflow", () => {
    expect(registryMenuPosition({ right: 900, top: 550, bottom: 570 }, 240, 160, 800, 600)).toEqual({ left: 552, top: 386 });
  });
  it("clamps tall menus and left-edge triggers inside the viewport", () => {
    expect(registryMenuPosition({ right: 80, top: 100, bottom: 120 }, 240, 584, 800, 600)).toEqual({ left: 8, top: 8 });
  });
});
