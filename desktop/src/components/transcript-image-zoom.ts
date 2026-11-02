import { iconButtonClass } from "../lib/icon-button";

export interface ZoomImage {
  src: string;
  alt: string;
  path?: string;
  width: number;
  height: number;
}

/** Decorate only transcript media; never intercept its existing open/caption action. */
export function createTranscriptImageZoom(
  icon: () => SVGElement | undefined,
  open: (image: ZoomImage) => void,
) {
  return (node: HTMLElement) => {
    const wrappers = new Set<HTMLElement>();
    const selector = "img.markdown-media-content, img[data-transcript-image]";
    const decorate = (root: Element) => {
      const images = root.matches(selector)
        ? [root as HTMLImageElement]
        : root.querySelectorAll<HTMLImageElement>(selector);
      for (const image of images) {
        const frame = image.closest<HTMLElement>("a.markdown-media-frame, button") ?? image;
        if (frame.parentElement?.classList.contains("transcript-image-zoom")) continue;
        const wrapper = document.createElement("span");
        wrapper.className = "transcript-image-zoom";
        frame.before(wrapper);
        wrapper.append(frame);
        const button = document.createElement("button");
        button.type = "button";
        button.className = iconButtonClass("md", "popover", { extra: "transcript-image-zoom-button" });
        button.title = "View full-size image";
        button.setAttribute("aria-label", "View full-size image");
        const glyph = icon()?.cloneNode(true) as SVGElement | undefined;
        if (glyph) button.append(glyph);
        button.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          // Read at activation, not decoration: lazy loading may replace the source.
          const currentImage = frame === image ? image : frame.querySelector("img");
          const src = currentImage?.currentSrc || currentImage?.getAttribute("src");
          if (src && currentImage && currentImage.naturalWidth > 0 && currentImage.naturalHeight > 0) {
            open({ src, alt: currentImage.alt, path: currentImage.dataset.imagePath, width: currentImage.naturalWidth, height: currentImage.naturalHeight });
          }
        };
        wrapper.append(button);
        wrappers.add(wrapper);
      }
    };
    const observer = new MutationObserver((records) => {
      for (const wrapper of wrappers) {
        if (!node.contains(wrapper)) wrappers.delete(wrapper);
      }
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (added instanceof Element && node.contains(added)) decorate(added);
        }
      }
    });
    observer.observe(node, { childList: true, subtree: true });
    decorate(node);
    return {
      destroy() {
        observer.disconnect();
        for (const wrapper of wrappers) {
          const frame = wrapper.firstElementChild;
          if (frame) wrapper.replaceWith(frame);
        }
        wrappers.clear();
      },
    };
  };
}
