/*
 * Shared attached-pane disclosure geometry (wiki/desktop/design.md §12.3): a 32 px muted
 * header row on the panel surface. Each <summary> still renders its own
 * state-rotating Lucide chevron next to the label.
 */
export const paneDisclosureClass = "border-t border-sidebar-border bg-panel";
export const paneDisclosureSummaryClass = "flex h-8 items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:-outline-offset-2";
