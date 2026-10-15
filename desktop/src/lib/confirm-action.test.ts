import { afterEach, describe, expect, it, vi } from "vitest";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import capabilitySource from "../../src-tauri/capabilities/default.json?raw";
import { confirmDesktopAction } from "./confirm-action";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(), invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("destructive action confirmation", () => {
  it("grants the current native message permission", () => {
    const permissions = JSON.parse(capabilitySource).permissions as string[];
    expect(permissions).toContain("dialog:allow-message");
    expect(permissions).not.toContain("dialog:allow-confirm");
  });

  it("does not allow legacy window.confirm at native application call sites", () => {
    const files = import.meta.glob<string>([
      "../**/*.{ts,js,svelte}",
      "!../**/*.test.ts",
      "!../lib/confirm-action.ts",
      "!../lib/close-confirmation.ts",
    ], { query: "?raw", import: "default", eager: true });
    const violations = Object.entries(files)
      .filter(([, source]) => /\bwindow\.confirm\s*\(/.test(source))
      .map(([path]) => path);
    expect(violations).toEqual([]);
  });

  it("uses supported async dialog API, not Tauri's broken window.confirm shim", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(confirm).mockResolvedValue(true);
    const legacy = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal("window", { confirm: legacy });
    await expect(confirmDesktopAction("Delete file?", { okLabel: "Delete" })).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith("Delete file?", {
      kind: "warning", okLabel: "Delete", cancelLabel: "Cancel",
    });
    expect(legacy).not.toHaveBeenCalled();
  });

  it("fails closed and logs when the native dialog bridge rejects", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(confirm).mockRejectedValue(new Error("Command not found"));
    await expect(confirmDesktopAction("Discard?")).resolves.toBe(false);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("log_desktop_diagnostic",
      expect.objectContaining({ event: "frontend:error" })));
  });

  it("requires an actual boolean from the browser fallback", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const fallback = vi.fn(() => true);
    vi.stubGlobal("window", { confirm: fallback });
    await expect(confirmDesktopAction("Discard?")).resolves.toBe(true);
    fallback.mockImplementation(() => Promise.resolve(true) as unknown as boolean);
    await expect(confirmDesktopAction("Discard?")).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});
