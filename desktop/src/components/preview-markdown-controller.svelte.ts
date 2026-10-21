import type { ProjectFileLineRange, ProjectFilePreview } from "../lib/project-files";

interface PreviewMarkdownControllerOptions {
  readonly previewId: () => number;
  readonly file: () => ProjectFilePreview | undefined;
  readonly onValidateProjectFile: () => ((path: string) => Promise<boolean | "directory">) | undefined;
  readonly onOpenProjectFile: () => ((path: string, range?: ProjectFileLineRange) => void | Promise<void>) | undefined;
  readonly onOpenLocalFile: () => ((path: string) => void | Promise<void>) | undefined;
  readonly rememberScroll: () => void;
}

export function createPreviewMarkdownController(options: PreviewMarkdownControllerOptions) {
  const resolvedProjectPaths = new Map<string, { path: string; validation: true | "directory" }>();

  $effect(() => {
    options.previewId();
    resolvedProjectPaths.clear();
  });

  function projectLinkPath(path: string): string {
    const normalizedFilePath = options.file()?.path.replaceAll("\\", "/");
    const directory = normalizedFilePath?.includes("/")
      ? normalizedFilePath.slice(0, normalizedFilePath.lastIndexOf("/"))
      : "";
    return directory ? `${directory}/${path}` : path;
  }

  async function resolveProject(path: string): Promise<{ path: string; validation: true | "directory" } | undefined> {
    const cached = resolvedProjectPaths.get(path);
    if (cached) return cached;
    const validate = options.onValidateProjectFile();
    if (!validate) return undefined;

    // Agent-authored Markdown commonly cites workspace-root paths such as
    // external/foo.ts even when the current Markdown file lives in specs/.
    // Try that exact project path first, then preserve normal document-relative
    // Markdown links as a fallback.
    const relative = projectLinkPath(path);
    const candidates = relative === path ? [path] : [path, relative];
    for (const candidate of candidates) {
      try {
        const validation = await validate(candidate);
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
