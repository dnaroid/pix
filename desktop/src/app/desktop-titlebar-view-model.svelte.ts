import type { ComponentProps } from "svelte";
import DesktopTitlebar from "../components/DesktopTitlebar.svelte";
import { projectAbbreviation, projectFolderHue, projectName } from "../lib/recent-projects";

type TitlebarProps = ComponentProps<typeof DesktopTitlebar>;
type WorkbenchProps = TitlebarProps["workbench"];
type SelectorProps = NonNullable<TitlebarProps["selector"]>;

export function createDesktopTitlebarViewModel(options: {
  workspace: () => string;
  workspaceColor: () => string | undefined;
  newSessionShortcut: () => WorkbenchProps["newSessionShortcut"];
  tabs: () => WorkbenchProps["tabs"];
  activeId: () => WorkbenchProps["activeId"];
  canCreateSession: () => boolean;
  selectWorkbenchTab: WorkbenchProps["onSelect"];
  closeWorkbenchTab: WorkbenchProps["onClose"];
  openSessionStartTab: () => void | Promise<void>;
  selectorOpen: () => boolean;
  sessions: () => SelectorProps["sessions"];
  activeSessionId: () => SelectorProps["activeSessionId"];
  activeTitle: () => string;
  selectorQuery: () => string;
  selectorMode: () => SelectorProps["mode"];
  sessionMutationRunning: () => boolean;
  deleteSession: (sessionId: string) => void | Promise<void>;
  selectSession: SelectorProps["onSelect"];
  closeSelector: SelectorProps["onClose"];
}) {
  const project = $derived.by<TitlebarProps["project"]>(() => {
    const workspace = options.workspace();
    if (!workspace) return null;
    return {
      path: workspace,
      name: projectName(workspace),
      abbreviation: projectAbbreviation(workspace),
      hue: projectFolderHue(workspace),
      color: options.workspaceColor(),
    };
  });

  const workbench = $derived.by<WorkbenchProps>(() => ({
    tabs: options.tabs(),
    activeId: options.activeId(),
    canCreateSession: options.canCreateSession(),
    newSessionShortcut: options.newSessionShortcut(),
    onSelect: options.selectWorkbenchTab,
    onClose: options.closeWorkbenchTab,
    onCreateSession: () => void options.openSessionStartTab(),
  }));

  const selector = $derived.by<TitlebarProps["selector"]>(() => {
    if (!options.selectorOpen()) return null;
    const mode = options.selectorMode();
    return {
      sessions: options.sessions(),
      activeSessionId: options.activeSessionId(),
      activeTitle: options.activeTitle(),
      initialQuery: options.selectorQuery(),
      mode,
      canCreate: mode === "open" && options.canCreateSession(),
      disabled: options.sessionMutationRunning(),
      onCreate: () => void options.openSessionStartTab(),
      onSelect: mode === "delete"
        ? (sessionId: string) => void options.deleteSession(sessionId)
        : options.selectSession,
      onClose: options.closeSelector,
    };
  });

  return {
    get project() { return project; },
    get workbench() { return workbench; },
    get selector() { return selector; },
  };
}
