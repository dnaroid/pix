import type { SidebarIndicatorTab } from "../lib/sidebar-indicators";

const ACTIVITY_BAR_WIDTH = 40;
const DEFAULT_WIDTH = 296;
const MIN_WIDTH = 236;
const GIT_MIN_WIDTH = 360;
const REGISTRY_MIN_WIDTH = 344;
const SETTINGS_MIN_WIDTH = 360;
const SCRIPTS_MIN_WIDTH = 400;
const IDX_MIN_WIDTH = 420;
const MIN_MAIN_WORKSPACE_WIDTH = 280;
const WIDTH_KEY = "pix.desktop.taskSidebarWidth";
const COLLAPSED_KEY = "pix.desktop.taskSidebarCollapsed";

interface WorkspaceSidebarLayoutControllerOptions {
  readonly activeTab: () => SidebarIndicatorTab;
}

export function createWorkspaceSidebarLayoutController(options: WorkspaceSidebarLayoutControllerOptions) {
  let collapsed = $state(false);
  let projectSwitcherMinimumWidth = $state(MIN_WIDTH);
  let sidebarWidth = $state(DEFAULT_WIDTH);
  let viewportWidth = $state(1240);
  let resizePointerId = $state<number | null>(null);
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  let previousDocumentUserSelect: string | null = null;
  let previousDocumentCursor: string | null = null;

  const activeMinWidth = $derived(sidebarMinWidth(options.activeTab()));
  const activeMaxWidth = $derived(Math.max(
    activeMinWidth,
    viewportWidth - ACTIVITY_BAR_WIDTH - MIN_MAIN_WORKSPACE_WIDTH,
  ));
  const expandedWidth = $derived(clampWidth(sidebarWidth, activeMinWidth, activeMaxWidth));
  const renderedWidth = $derived(ACTIVITY_BAR_WIDTH + (collapsed ? 0 : expandedWidth));
  const renderedMinWidth = $derived(ACTIVITY_BAR_WIDTH + (collapsed ? 0 : activeMinWidth));

  function mount(): () => void {
    const updateViewportWidth = (): void => {
      viewportWidth = window.innerWidth;
    };
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    try {
      collapsed = localStorage.getItem(COLLAPSED_KEY) === "true";
      const savedWidth = localStorage.getItem(WIDTH_KEY);
      if (savedWidth !== null) {
        const parsedWidth = Number(savedWidth);
        if (Number.isFinite(parsedWidth)) sidebarWidth = clampWidth(parsedWidth, activeMinWidth, activeMaxWidth);
      }
    } catch {
      // Keep defaults when webview storage is unavailable.
    }
    return () => {
      window.removeEventListener("resize", updateViewportWidth);
      setDocumentResizeState(false);
    };
  }

  function setCollapsed(next: boolean): void {
    collapsed = next;
    try {
      localStorage.setItem(COLLAPSED_KEY, String(next));
    } catch {
      // Persistence is a convenience, not a requirement for sidebar use.
    }
  }

  function startResize(event: PointerEvent): void {
    if (collapsed || event.button !== 0) return;
    event.preventDefault();
    resizePointerId = event.pointerId;
    resizeStartX = event.clientX;
    resizeStartWidth = expandedWidth;
    setDocumentResizeState(true);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function resize(event: PointerEvent): void {
    if (event.pointerId !== resizePointerId) return;
    const candidate = resizeStartWidth + event.clientX - resizeStartX;
    if (candidate <= activeMinWidth && sidebarWidth < activeMinWidth) return;
    sidebarWidth = clampWidth(candidate, activeMinWidth, activeMaxWidth);
  }

  function finishResize(event: PointerEvent): void {
    if (event.pointerId !== resizePointerId) return;
    resizePointerId = null;
    setDocumentResizeState(false);
    persistWidth();
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
    event.preventDefault();
    if (event.key === "Home") {
      sidebarWidth = DEFAULT_WIDTH;
    } else if (event.key === "ArrowLeft" && sidebarWidth < activeMinWidth) {
      return;
    } else {
      const baseWidth = Math.max(sidebarWidth, activeMinWidth);
      sidebarWidth = clampWidth(
        baseWidth + (event.key === "ArrowLeft" ? -12 : 12),
        activeMinWidth,
        activeMaxWidth,
      );
    }
    persistWidth();
  }

  function resetWidth(): void {
    sidebarWidth = DEFAULT_WIDTH;
  }

  function setProjectSwitcherMinimumWidth(width: number): void {
    if (!Number.isFinite(width)) return;
    projectSwitcherMinimumWidth = Math.max(MIN_WIDTH, Math.ceil(width));
  }

  function setDocumentResizeState(active: boolean): void {
    const root = document.documentElement;
    if (active) {
      if (previousDocumentUserSelect === null) previousDocumentUserSelect = root.style.userSelect;
      if (previousDocumentCursor === null) previousDocumentCursor = root.style.cursor;
      root.style.userSelect = "none";
      root.style.cursor = "col-resize";
      return;
    }

    if (previousDocumentUserSelect !== null) {
      root.style.userSelect = previousDocumentUserSelect;
      previousDocumentUserSelect = null;
    }
    if (previousDocumentCursor !== null) {
      root.style.cursor = previousDocumentCursor;
      previousDocumentCursor = null;
    }
  }

  function sidebarMinWidth(tab: SidebarIndicatorTab): number {
    if (tab === "project") return Math.max(MIN_WIDTH, projectSwitcherMinimumWidth);
    if (tab === "git") return GIT_MIN_WIDTH;
    if (tab === "registry") return REGISTRY_MIN_WIDTH;
    if (tab === "settings") return SETTINGS_MIN_WIDTH;
    if (tab === "scripts") return SCRIPTS_MIN_WIDTH;
    if (tab === "idx") return IDX_MIN_WIDTH;
    return MIN_WIDTH;
  }

  function clampWidth(width: number, minimum = MIN_WIDTH, maximum = Number.POSITIVE_INFINITY): number {
    return Math.min(maximum, Math.max(minimum, width));
  }

  function persistWidth(): void {
    try {
      localStorage.setItem(WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Keep the in-memory width when persistence is unavailable.
    }
  }

  return {
    get collapsed() { return collapsed; },
    get resizing() { return resizePointerId !== null; },
    get activeMinWidth() { return activeMinWidth; },
    get activeMaxWidth() { return activeMaxWidth; },
    get expandedWidth() { return expandedWidth; },
    get renderedWidth() { return renderedWidth; },
    get renderedMinWidth() { return renderedMinWidth; },
    mount,
    setCollapsed,
    startResize,
    resize,
    finishResize,
    resizeWithKeyboard,
    resetWidth,
    setProjectSwitcherMinimumWidth,
  };
}

export type WorkspaceSidebarLayoutController = ReturnType<typeof createWorkspaceSidebarLayoutController>;
