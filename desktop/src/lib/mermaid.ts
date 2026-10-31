import mermaid from "mermaid";

let diagramSequence = 0;
let activeThemeKey = "";

type MermaidTheme = {
  background: string;
  border: string;
  card: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  primary: string;
};

type CachedDiagram = { readonly promise: Promise<string | undefined>; settled: boolean; svg?: string };

// Streaming Markdown replaces its DOM every frame; diagrams already rendered
// for the same source and theme are reused instead of re-rendered.
const MAX_CACHED_DIAGRAMS = 32;
const diagramCache = new Map<string, CachedDiagram>();

/** Theme identity for {@link cachedMermaidDiagram}; read once per render pass. */
export function mermaidThemeKey(themeRoot: HTMLElement): string {
  return JSON.stringify(mermaidTheme(themeRoot));
}

/** A settled render for this source and theme, or `null` when none is cached yet. */
export function cachedMermaidDiagram(source: string, themeKey: string): string | undefined | null {
  const cached = diagramCache.get(`${themeKey}\0${source}`);
  return cached?.settled ? cached.svg : null;
}

export function renderMermaidDiagram(
  source: string,
  themeRoot: HTMLElement,
): Promise<string | undefined> {
  const themeKey = mermaidThemeKey(themeRoot);
  const key = `${themeKey}\0${source}`;
  const cached = diagramCache.get(key);
  if (cached) {
    diagramCache.delete(key);
    diagramCache.set(key, cached);
    return cached.promise;
  }
  const entry: CachedDiagram = {
    settled: false,
    promise: renderUncached(source, themeRoot, themeKey).then(
      (svg) => {
        entry.settled = true;
        entry.svg = svg;
        return svg;
      },
      (error: unknown) => {
        if (diagramCache.get(key) === entry) diagramCache.delete(key);
        throw error;
      },
    ),
  };
  diagramCache.set(key, entry);
  for (const oldest of diagramCache.keys()) {
    if (diagramCache.size <= MAX_CACHED_DIAGRAMS) break;
    diagramCache.delete(oldest);
  }
  return entry.promise;
}

async function renderUncached(
  source: string,
  themeRoot: HTMLElement,
  themeKey: string,
): Promise<string | undefined> {
  configureMermaid(themeRoot, themeKey);

  const parsed = await mermaid.parse(source, { suppressErrors: true });
  if (!parsed) return undefined;

  diagramSequence += 1;
  const { svg } = await mermaid.render(`pix-mermaid-${diagramSequence}`, source);
  return svg;
}

function configureMermaid(themeRoot: HTMLElement, themeKey: string): void {
  if (themeKey === activeThemeKey) return;
  const theme = mermaidTheme(themeRoot);

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "maxEdges",
      "suppressErrorRendering",
      "htmlLabels",
      "theme",
      "themeVariables",
      "fontFamily",
    ],
    suppressErrorRendering: true,
    maxTextSize: 50_000,
    htmlLabels: false,
    theme: "base",
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
    themeVariables: {
      background: theme.background,
      primaryColor: theme.muted,
      primaryTextColor: theme.foreground,
      primaryBorderColor: theme.border,
      secondaryColor: theme.card,
      secondaryTextColor: theme.foreground,
      secondaryBorderColor: theme.border,
      tertiaryColor: theme.background,
      tertiaryTextColor: theme.foreground,
      tertiaryBorderColor: theme.border,
      lineColor: theme.mutedForeground,
      textColor: theme.foreground,
      mainBkg: theme.muted,
      nodeBorder: theme.border,
      clusterBkg: theme.card,
      clusterBorder: theme.border,
      noteBkgColor: theme.card,
      noteTextColor: theme.foreground,
      noteBorderColor: theme.border,
      actorBkg: theme.card,
      actorBorder: theme.border,
      actorTextColor: theme.foreground,
      signalColor: theme.foreground,
      signalTextColor: theme.foreground,
      labelBoxBkgColor: theme.background,
      labelBoxBorderColor: theme.border,
      labelTextColor: theme.foreground,
      activationBkgColor: theme.muted,
      activationBorderColor: theme.primary,
      sequenceNumberColor: theme.background,
    },
  });
  activeThemeKey = themeKey;
}

function mermaidTheme(themeRoot: HTMLElement): MermaidTheme {
  const styles = getComputedStyle(themeRoot);
  const value = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: value("--background"),
    border: value("--border"),
    card: value("--card"),
    foreground: value("--foreground"),
    muted: value("--muted"),
    mutedForeground: value("--muted-foreground"),
    primary: value("--primary"),
  };
}
