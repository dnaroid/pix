import { prepareHtmlSandbox, type PreparedHtmlSandbox } from "./html-sandbox";

type RunResult = PreparedHtmlSandbox | { error: string };

/** Cancel logical ownership, including late errors; cached library loads may finish. */
export function createSandboxRun(prepare = prepareHtmlSandbox) {
  let generation = 0;
  return {
    cancel() { generation += 1; },
    async start(source: string): Promise<RunResult | undefined> {
      const owner = ++generation;
      try {
        const result = await prepare(source);
        return generation === owner ? result : undefined;
      } catch (error) {
        return generation === owner
          ? { error: error instanceof Error ? error.message : "Unable to start preview." }
          : undefined;
      }
    },
  };
}
