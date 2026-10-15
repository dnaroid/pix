import { claudeLoginCommand, claudeLoginProfiles } from "../lib/claude-login-recovery";

export function createClaudeLoginController(options: {
  readConfig: () => Promise<string>;
  openTerminal: (command: string) => Promise<void>;
  reportError: (error: unknown) => void;
}) {
  let busy = $state(false);
  let profiles = $state<ReturnType<typeof claudeLoginProfiles> | null>(null);
  let selected = $state("");
  let error = $state("");
  let disposed = false;

  async function login(): Promise<void> {
    if (busy || disposed) return;
    busy = true;
    error = "";
    try {
      // Reread on every launch: Settings may have changed since preparation.
      const current = claudeLoginProfiles(await options.readConfig());
      if (disposed) return;
      if (!profiles && current.accounts.length > 0) {
        profiles = current;
        selected = current.selected;
        return; // Explicit choice/confirmation before touching a named login.
      }
      const account = current.accounts.find((item) => item.name === selected);
      if (selected && !account) {
        profiles = current;
        selected = current.selected;
        error = "Claude profiles changed. Review the selected account and try again.";
        options.reportError(new Error(error));
        return;
      }
      await options.openTerminal(claudeLoginCommand(account?.configDir));
    } catch {
      if (!disposed) {
        error = "Could not start Claude sign-in. Check Tools Suite settings or the terminal, then try again.";
        // Paths/identity from config errors do not belong in diagnostics.
        options.reportError(new Error(error));
      }
    } finally {
      if (!disposed) busy = false;
    }
  }

  return {
    get busy() { return busy; },
    get profiles() { return profiles; },
    get selected() { return selected; },
    get error() { return error; },
    select(value: string) { if (!busy) selected = value; },
    login,
    dispose() { disposed = true; },
  };
}
