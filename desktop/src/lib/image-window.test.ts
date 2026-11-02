import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { imageWindowPayload, openImageWindow } from "./image-window";
import mainSource from "../main.ts?raw";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => { vi.mocked(invoke).mockReset(); });

describe("native image window bridge", () => {
  it("sends natural dimensions and the existing authorized source, not a parent viewport bound or new file grant", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await openImageWindow({ src: "asset://localhost/image.png", alt: "Diagram", width: 1600, height: 900, path: "/image.png" });
    expect(invoke).toHaveBeenCalledWith("desktop_open_image_window", {
      image: { src: "asset://localhost/image.png", alt: "Diagram", width: 1600, height: 900 },
    });
  });

  it("requests its own payload without allowing a caller-selected window label", async () => {
    const image = { src: "data:image/png;base64,AA==", alt: "", width: 1, height: 1 };
    vi.mocked(invoke).mockResolvedValue(image);
    expect(await imageWindowPayload()).toEqual(image);
    expect(invoke).toHaveBeenCalledWith("desktop_image_window_payload");
  });

  it("propagates native open failure for the transcript diagnostic handler", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no monitor available"));
    await expect(openImageWindow({ src: "asset://localhost/image.png", alt: "", width: 1, height: 1 })).rejects.toThrow("no monitor available");
  });

  it("boots the viewer separately without mounting the workbench or starting its runtimes", () => {
    expect(mainSource).not.toContain('import App from "./App.svelte"');
    expect(mainSource).toContain('get("imageViewer") === "1"');
    expect(mainSource).toContain('await import("./components/ImageViewerWindow.svelte")');
    expect(mainSource).toContain('await import("./App.svelte")');
  });
});
