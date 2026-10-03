import { afterEach, describe, expect, it, vi } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { confirmRunningTabClose } from "./close-confirmation";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("running tab confirmation", () => {
  it("uses the native warning dialog in Desktop", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(confirm).mockResolvedValue(false);
    await expect(confirmRunningTabClose("Build")).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Build"), {
      title: "Close running conversation?", kind: "warning", okLabel: "Close tab", cancelLabel: "Cancel",
    });
  });
  it("keeps a browser fallback for web preview", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const fallback = vi.fn(() => true);
    vi.stubGlobal("window", { confirm: fallback });
    await expect(confirmRunningTabClose("Build")).resolves.toBe(true);
    expect(fallback).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });
});
