export function createErrorState() {
  let message = $state<string | null>(null);

  function set(next: string | null): void {
    message = next;
  }

  function clear(): void {
    message = null;
  }

  function report(error: unknown): void {
    message = error instanceof Error ? error.message : String(error);
  }

  return {
    get message() { return message; },
    set,
    clear,
    report,
  };
}
