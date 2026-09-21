export interface CompletionSpacedPollOptions {
  readonly delayMs: number;
  readonly shouldRun: () => boolean;
  readonly task: () => Promise<void>;
}

/**
 * Run a best-effort poll only after a full quiet delay. The next timer starts
 * after the previous task settles, so slow work cannot collapse the idle gap.
 */
export function startCompletionSpacedPoll(options: CompletionSpacedPollOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      void runOnce();
    }, options.delayMs);
  };

  const runOnce = async (): Promise<void> => {
    try {
      if (options.shouldRun()) await options.task();
    } finally {
      schedule();
    }
  };

  schedule();
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}
