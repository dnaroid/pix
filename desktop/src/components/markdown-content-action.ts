import { convertFileSrc } from "@tauri-apps/api/core";
import type { Attachment } from "../lib/attachments";
import { renderMermaidDiagram } from "../lib/mermaid";
import {
  FileLinkValidationCache,
  type FileLinkScope,
  type FileLinkValidator,
} from "./file-link-validation-cache";

interface MarkdownContentActionOptions {
  readonly externalLinkIconTemplate: () => HTMLSpanElement | undefined;
  readonly onValidateProjectFile: () => ((path: string) => Promise<boolean>) | undefined;
  readonly onValidateLocalFile: () => ((path: string) => Promise<boolean>) | undefined;
  readonly onResolveProjectMedia: () => ((path: string) => Promise<Attachment | undefined>) | undefined;
  readonly onResolveLocalMedia: () => ((path: string) => Promise<Attachment | undefined>) | undefined;
}

export function createMarkdownContentAction(options: MarkdownContentActionOptions) {
  const mediaCache = new Map<string, Promise<Attachment | undefined>>();

  function decorateExternalLinks(node: HTMLElement): void {
    const template = options.externalLinkIconTemplate()?.querySelector("svg");
    if (!template) return;

    for (const link of node.querySelectorAll<HTMLAnchorElement>("a[data-external-link]")) {
      if (link.querySelector(":scope > .markdown-external-link-icon")) continue;
      if (link.querySelector(":scope > img")) continue;
      const icon = template.cloneNode(true) as SVGElement;
      icon.classList.add("markdown-external-link-icon");
      icon.setAttribute("aria-hidden", "true");
      link.append(icon);
    }
  }

  return function markdownContent(node: HTMLElement, _renderedHtml: string) {
    let generation = 0;
    let destroyed = false;
    const fileLinkValidationCache = new FileLinkValidationCache();
    let mediaObserver: IntersectionObserver | undefined;
    let diagramObserver: IntersectionObserver | undefined;
    let fileLinkObserver: IntersectionObserver | undefined;
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");

    function scheduleRender() {
      generation += 1;
      const scheduledGeneration = generation;
      queueMicrotask(() => {
        if (scheduledGeneration !== generation) return;
        decorateExternalLinks(node);
        observeFileLinks(scheduledGeneration);
        observeDiagrams(scheduledGeneration);
        observeMedia(scheduledGeneration);
      });
    }

    function observeFileLinks(scheduledGeneration: number): void {
      if (scheduledGeneration !== generation) return;
      fileLinkObserver?.disconnect();
      const candidates = Array.from(node.querySelectorAll<HTMLElement>(
        "[data-project-file-candidate], [data-local-file-candidate]",
      ));
      const validate = (candidate: HTMLElement) => {
        void validateFileLink(candidate);
      };
      const unvalidated = candidates.filter((candidate) => {
        const target = fileLinkTarget(candidate);
        if (!target) {
          invalidateFileLink(candidate);
          return false;
        }
        const cached = fileLinkValidationCache.peek(target.scope, target.path, target.validator);
        if (cached === true) {
          replaceFileLinkCandidate(candidate, target);
          return false;
        }
        if (cached === false) {
          invalidateFileLink(candidate);
          return false;
        }
        if (cached) {
          // The preceding visible candidate started this request. Attach the
          // regenerated candidate without starting another filesystem check.
          validate(candidate);
          return false;
        }
        return true;
      });
      if (typeof IntersectionObserver === "undefined") {
        for (const candidate of unvalidated) validate(candidate);
        return;
      }
      fileLinkObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
          observer.unobserve(entry.target);
          validate(entry.target);
        }
      }, { rootMargin: "320px 0px" });
      for (const candidate of unvalidated) fileLinkObserver.observe(candidate);
    }

    async function validateFileLink(candidate: HTMLElement): Promise<void> {
      const target = fileLinkTarget(candidate);
      if (!target) return;
      let exists = false;
      try {
        exists = await fileLinkValidationCache.validate(target.scope, target.path, target.validator);
      } catch {
        exists = false;
      }
      if (destroyed || !node.contains(candidate) || !isCurrentFileLinkTarget(candidate, target)) return;
      if (!exists) {
        invalidateFileLink(candidate);
        return;
      }
      replaceFileLinkCandidate(candidate, target);
    }

    function fileLinkTarget(candidate: HTMLElement): FileLinkTarget | undefined {
      const projectPath = candidate.dataset.projectFileCandidate;
      const localPath = candidate.dataset.localFileCandidate;
      const scope: FileLinkScope = projectPath ? "project" : "local";
      const path = projectPath ?? localPath;
      const validator = projectPath ? options.onValidateProjectFile() : options.onValidateLocalFile();
      if (!path || !validator) return undefined;
      return { scope, path, validator, projectPath };
    }

    function isCurrentFileLinkTarget(candidate: HTMLElement, target: FileLinkTarget): boolean {
      const current = fileLinkTarget(candidate);
      return current?.scope === target.scope
        && current.path === target.path
        && current.validator === target.validator;
    }

    function observeMedia(scheduledGeneration: number): void {
      if (scheduledGeneration !== generation) return;
      mediaObserver?.disconnect();
      const previews = Array.from(node.querySelectorAll<HTMLElement>(
        ".markdown-media[data-project-media], .markdown-media[data-local-media]",
      ));
      const render = (preview: HTMLElement) => {
        if (preview.dataset.mediaState === "loading" || preview.dataset.mediaState === "ready") return;
        void renderMediaPreview(preview, scheduledGeneration);
      };
      if (typeof IntersectionObserver === "undefined") {
        for (const preview of previews) render(preview);
        return;
      }
      mediaObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
          observer.unobserve(entry.target);
          render(entry.target);
        }
      }, { rootMargin: "320px 0px" });
      for (const preview of previews) mediaObserver.observe(preview);
    }

    async function renderMediaPreview(preview: HTMLElement, scheduledGeneration: number): Promise<void> {
      const projectPath = preview.dataset.projectFile;
      const localPath = preview.dataset.localFile;
      const path = projectPath ?? localPath;
      const scope = projectPath ? "project" : "local";
      const kind = projectPath ? preview.dataset.projectMedia : preview.dataset.localMedia;
      const resolver = projectPath ? options.onResolveProjectMedia() : options.onResolveLocalMedia();
      const frame = preview.querySelector<HTMLElement>(".markdown-media-frame");
      if (!path || !resolver || (kind !== "image" && kind !== "video") || !frame) return;
      const label = projectPath
        ? preview.dataset.projectMediaLabel || path
        : preview.dataset.localMediaLabel || path;

      preview.dataset.mediaState = "loading";
      frame.setAttribute("aria-busy", "true");
      try {
        const cacheKey = `${scope}:${path}`;
        let request = mediaCache.get(cacheKey);
        if (!request) {
          request = resolver(path);
          mediaCache.set(cacheKey, request);
        }
        const attachment = await request;
        if (scheduledGeneration !== generation || !node.contains(preview)) return;
        if (!attachment?.path || attachment.kind !== kind) {
          showMediaError(frame, preview);
          return;
        }

        let media: HTMLImageElement | HTMLVideoElement;
        if (kind === "image") {
          const image = document.createElement("img");
          image.alt = label;
          image.loading = "lazy";
          image.decoding = "async";
          media = image;
        } else {
          const video = document.createElement("video");
          video.controls = true;
          video.preload = "metadata";
          video.playsInline = true;
          video.setAttribute("aria-label", label);
          media = video;
        }
        media.src = convertFileSrc(attachment.path);
        media.className = "markdown-media-content";
        media.addEventListener(
          "error",
          () => {
            const currentFrame = preview.querySelector<HTMLElement>(".markdown-media-frame");
            if (node.contains(preview) && currentFrame) showMediaError(currentFrame, preview);
          },
          { once: true },
        );
        if (kind === "image") {
          const link = document.createElement("a");
          link.href = "#";
          link.className = frame.className;
          link.title = `Preview ${path}`;
          link.setAttribute("aria-label", `Preview ${label}`);
          if (projectPath) link.dataset.projectFile = path;
          else link.dataset.localFile = path;
          link.append(media);
          frame.replaceWith(link);
        } else {
          frame.replaceChildren(media);
          frame.removeAttribute("aria-busy");
        }
        preview.dataset.mediaState = "ready";
      } catch (error: unknown) {
        if (scheduledGeneration !== generation || !node.contains(preview)) return;
        console.warn(`Failed to render ${scope} media ${path}`, error);
        showMediaError(frame, preview);
      }
    }

    function observeDiagrams(scheduledGeneration: number): void {
      if (scheduledGeneration !== generation) return;
      diagramObserver?.disconnect();
      const diagrams = Array.from(node.querySelectorAll<HTMLElement>(".mermaid-diagram"));
      const render = (diagram: HTMLElement) => {
        if (diagram.dataset.mermaidState === "loading") return;
        void renderDiagram(diagram, scheduledGeneration);
      };
      if (typeof IntersectionObserver === "undefined") {
        for (const diagram of diagrams) render(diagram);
        return;
      }
      diagramObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
          observer.unobserve(entry.target);
          render(entry.target);
        }
      }, { rootMargin: "320px 0px" });
      for (const diagram of diagrams) diagramObserver.observe(diagram);
    }

    async function renderDiagram(diagram: HTMLElement, scheduledGeneration: number): Promise<void> {
      const source = diagram.dataset.mermaidSource;
      const canvas = diagram.querySelector<HTMLElement>(".mermaid-canvas");
      if (source === undefined || !canvas) return;

      diagram.dataset.mermaidState = "loading";
      canvas.setAttribute("aria-busy", "true");
      try {
        const svg = await renderMermaidDiagram(source, node);
        if (scheduledGeneration !== generation || !node.contains(diagram)) return;

        if (svg) {
          canvas.innerHTML = svg;
          canvas.setAttribute("role", "img");
          canvas.setAttribute("aria-label", "Mermaid diagram");
          diagram.dataset.mermaidState = "rendered";
        } else {
          showMermaidError(canvas, diagram);
        }
      } catch (error: unknown) {
        if (scheduledGeneration !== generation || !node.contains(diagram)) return;
        console.warn("Failed to render Mermaid diagram", error);
        showMermaidError(canvas, diagram);
      } finally {
        if (scheduledGeneration === generation && node.contains(canvas)) {
          canvas.setAttribute("aria-busy", "false");
        }
      }
    }

    function handleColorSchemeChange() {
      scheduleRender();
    }

    colorScheme.addEventListener("change", handleColorSchemeChange);
    scheduleRender();
    return {
      update(_nextHtml: string) {
        scheduleRender();
      },
      destroy() {
        destroyed = true;
        generation += 1;
        fileLinkObserver?.disconnect();
        mediaObserver?.disconnect();
        diagramObserver?.disconnect();
        colorScheme.removeEventListener("change", handleColorSchemeChange);
      },
    };
  };
}

interface FileLinkTarget {
  readonly scope: FileLinkScope;
  readonly path: string;
  readonly validator: FileLinkValidator;
  readonly projectPath: string | undefined;
}

function invalidateFileLink(candidate: HTMLElement): void {
  candidate.dataset.fileValidationState = "invalid";
  delete candidate.dataset.projectFileCandidate;
  delete candidate.dataset.localFileCandidate;
}

function replaceFileLinkCandidate(candidate: HTMLElement, target: FileLinkTarget): void {
  const link = document.createElement("a");
  link.href = "#";
  link.title = `${target.projectPath ? "Preview" : "Open"} ${target.path}`;
  if (target.projectPath) {
    link.dataset.projectFile = target.path;
    const startLine = candidate.dataset.projectFileStartLine;
    const endLine = candidate.dataset.projectFileEndLine;
    if (startLine) link.dataset.projectFileStartLine = startLine;
    if (endLine) link.dataset.projectFileEndLine = endLine;
  } else {
    link.dataset.localFile = target.path;
  }
  while (candidate.firstChild) link.append(candidate.firstChild);
  candidate.replaceWith(link);
}

function showMermaidError(canvas: HTMLElement, diagram: HTMLElement) {
  const message = document.createElement("p");
  message.className = "mermaid-error";
  message.textContent = "Could not render this Mermaid diagram. Source is shown below.";
  canvas.replaceChildren(message);
  canvas.removeAttribute("role");
  canvas.removeAttribute("aria-label");
  diagram.dataset.mermaidState = "error";
}

function showMediaError(frame: HTMLElement, preview: HTMLElement) {
  const message = document.createElement("span");
  message.className = "markdown-media-status";
  message.textContent = "Preview unavailable";
  frame.replaceChildren(message);
  frame.removeAttribute("aria-busy");
  preview.dataset.mediaState = "error";
}
