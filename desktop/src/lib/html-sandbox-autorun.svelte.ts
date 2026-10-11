import { untrack } from "svelte";

/** Own a run for the HTML value, not for the surrounding transcript object. */
export function createSandboxAutorun(
  source: () => string,
  start: (source: string) => void,
  stop: () => void,
): void {
  const html = $derived(source());
  $effect(() => {
    const value = html;
    untrack(() => start(value));
    return stop;
  });
}
