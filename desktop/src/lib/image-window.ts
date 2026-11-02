import { invoke } from "@tauri-apps/api/core";
import type { ZoomImage } from "../components/transcript-image-zoom";

export function openImageWindow(image: ZoomImage): Promise<void> {
  return invoke("desktop_open_image_window", {
    image: { src: image.src, alt: image.alt, width: image.width, height: image.height },
  });
}

export function imageWindowPayload(): Promise<ZoomImage> {
  return invoke("desktop_image_window_payload");
}
