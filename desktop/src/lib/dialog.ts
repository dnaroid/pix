/*
 * Shared modal geometry and footer actions (DESIGN.md §10, §13). Keyboard
 * focus comes from the global :focus-visible ring in styles.css, which is
 * unlayered and therefore wins over any per-button outline utility.
 */
export const modalBackdropClass = "fixed inset-0 z-50 m-auto h-screen max-h-none w-screen max-w-none place-items-center bg-transparent p-6 text-foreground backdrop:bg-overlay open:grid";
export const dialogCancelButtonClass = "h-8 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40";
export const dialogPrimaryButtonClass = "inline-flex h-8 min-w-20 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40";
export const dialogDestructiveButtonClass = "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-destructive/10 px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40";
