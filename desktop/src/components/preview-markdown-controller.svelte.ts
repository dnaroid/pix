import type { ProjectFileLineRange, ProjectFilePreview } from "../lib/project-files";
import { resolveWikiLink } from "../lib/project-wiki";

interface PreviewMarkdownControllerOptions {
  readonly previewId: () => number;
  readonly file: () => ProjectFilePreview | undefined;
  readonly onValidateProjectFile: () => ((path: string) => Promise<boolean | "directory">) | undefined;
  readonly onOpenProjectFile: () => ((path: string, range?: ProjectFileLineRange) => void | Promise<void>) | undefined;
  readonly onOpenLocalFile: () => ((path: string) => void | Promise<void>) | undefined;
  readonly rememberScroll: () => void;
  readonly preferDocumentRelative?: () => boolean;
}

export function createPreviewMarkdownController(options: PreviewMarkdownControllerOptions) {
  const resolvedProjectPaths = new Map<string, { path: string; validation: true | "directory" }>();
  let disposed = false;
  let cacheScope = "";
  const scope = () => `${options.previewId()}\0${options.file()?.path ?? ""}\0${Boolean(options.preferDocumentRelative?.())}`;

  $effect(() => {
    options.previewId();
    resolvedProjectPaths.clear();
  });
  $effect(() => () => { disposed = true; resolvedProjectPaths.clear(); });

  function projectLinkPath(path: string): string {
    const normalizedFilePath = options.file()?.path.replaceAll("\\", "/");
    // MarkdownText already decodes destinations. Encode each path segment before
    // URL resolution so literal percent/hash characters remain filename content.
    const encoded = path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
    const resolved = normalizedFilePath && resolveWikiLink(normalizedFilePath, encoded);
    if (resolved) return resolved;
    const directory = normalizedFilePath?.includes("/")
      ? normalizedFilePath.slice(0, normalizedFilePath.lastIndexOf("/"))
      : "";
    return directory ? `${directory}/${path}` : path;
  }

  async function resolveProject(path: string): Promise<{ path: string; validation: true | "directory" } | undefined> {
    if (disposed) return undefined;
    const owner = scope();
    if (cacheScope !== owner) { resolvedProjectPaths.clear(); cacheScope = owner; }
    const cached = resolvedProjectPaths.get(path);
    if (cached) return cached;
    const validate = options.onValidateProjectFile();
    if (!validate) return undefined;

    // Agent-authored Markdown commonly cites workspace-root paths such as
    // external/foo.ts even when the current Markdown file lives in specs/.
    // Try that exact project path first, then preserve normal document-relative
    // Markdown links as a fallback.
    const relative = projectLinkPath(path);
    const candidates = options.preferDocumentRelative?.() ? [relative]
      : relative === path ? [path] : [path, relative];
    for (const candidate of candidates) {
      try {
        const validation = await validate(candidate);
        if (disposed || owner !== scope()) return undefined;
        if (!validation) continue;
        const resolved = { path: candidate, validation };
        resolvedProjectPaths.set(path, resolved);
        return resolved;
      } catch {
        // Try the next interpretation; validation is intentionally best-effort.
      }
    }
    return undefined;
  }

  async function openProject(path: string, range?: ProjectFileLineRange): Promise<void> {
    options.rememberScroll();
    const resolved = await resolveProject(path);
    if (resolved) await options.onOpenProjectFile()?.(resolved.path, range);
  }

  async function validateProject(path: string): Promise<boolean | "directory"> {
    return (await resolveProject(path))?.validation ?? false;
  }

  function openLocal(path: string): void | Promise<void> {
    options.rememberScroll();
    return options.onOpenLocalFile()?.(path);
  }

  return {
    projectLinkPath,
    openProject,
    validateProject,
    openLocal,
  };
}
