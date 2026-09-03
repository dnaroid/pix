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

export async function renderMermaidDiagram(
  source: string,
  themeRoot: HTMLElement,
): Promise<string | undefined> {
  configureMermaid(themeRoot);

  const parsed = await mermaid.parse(source, { suppressErrors: true });
  if (!parsed) return undefined;

  diagramSequence += 1;
  const { svg } = await mermaid.render(`pix-mermaid-${diagramSequence}`, source);
  return svg;
}

function configureMermaid(themeRoot: HTMLElement): void {
  const theme = mermaidTheme(themeRoot);
  const themeKey = JSON.stringify(theme);
  if (themeKey === activeThemeKey) return;

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
    fontFamily: '"Outfit", ui-sans-serif, system-ui, sans-serif',
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
