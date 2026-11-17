import { claudeLoginCommand } from "../lib/claude-login-recovery";

export function createClaudeLoginController(options: {
  openTerminal: (command: string) => Promise<void>;
  reportError: (error: unknown) => void;
}) {
  let busy = $state(false);
  let error = $state("");
  let disposed = false;

  async function login(): Promise<void> {
    if (busy || disposed) return;
    busy = true;
    error = "";
    try {
      await options.openTerminal(claudeLoginCommand());
    } catch {
      if (!disposed) {
        error = "Could not start Claude sign-in. Check the terminal, then try again.";
        // Terminal errors can carry local paths; diagnostics get the fixed text.
        options.reportError(new Error(error));
      }
    } finally {
      if (!disposed) busy = false;
    }
  }

  return {
    get busy() { return busy; },
    get error() { return error; },
    login,
    dispose() { disposed = true; },
  };
}
