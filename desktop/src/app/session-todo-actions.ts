import { SvelteSet } from "svelte/reactivity";
import type { AcpClient } from "../lib/acp-client";

/** Session-owned pending state survives inspector remounts and tab switches. */
export function createSessionTodoActions(options: {
  client: () => Pick<AcpClient, "clearTodos"> | null;
  ready: (sessionId: string) => boolean;
  reportError: (error: unknown) => void;
}) {
  const pending = new SvelteSet<string>();
  const canClear = (sessionId: string) => options.ready(sessionId) && !pending.has(sessionId);

  return {
    canClear,
    async clear(sessionId: string): Promise<boolean> {
      const client = options.client();
      if (!client || !canClear(sessionId)) return false;
      pending.add(sessionId);
      try {
        await client.clearTodos(sessionId);
        return true;
      } catch (error) {
        options.reportError(error);
        return false;
      } finally {
        pending.delete(sessionId);
      }
    },
  };
}
