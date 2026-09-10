<script lang="ts">
  import { idxOutputSegments } from "../lib/idx";
  import type { ProjectFileLineRange } from "../lib/project-files";

  let {
    text,
    className = "",
    onValidateProjectFile,
    onOpenProjectFile,
  }: {
    text: string;
    className?: string;
    onValidateProjectFile: (path: string) => Promise<boolean>;
    onOpenProjectFile: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
  } = $props();

  type ValidationState = "loading" | "valid" | "invalid";

  let validationStates = $state<Record<string, ValidationState>>({});
  const segments = $derived(idxOutputSegments(text));

  function lazyValidateFile(
    node: HTMLElement,
    initialPath: string,
  ): { update: (path: string) => void; destroy: () => void } {
    let path = initialPath;
    let observer: IntersectionObserver | undefined;
    let cancelled = false;

    const validate = () => {
      if (cancelled || validationStates[path]) return;
      validationStates = { ...validationStates, [path]: "loading" };
      const requestPath = path;
      void onValidateProjectFile(requestPath)
        .then((exists) => {
          if (cancelled || path !== requestPath) return;
          validationStates = { ...validationStates, [requestPath]: exists ? "valid" : "invalid" };
        })
        .catch(() => {
          if (cancelled || path !== requestPath) return;
          validationStates = { ...validationStates, [requestPath]: "invalid" };
        });
    };

    const observe = () => {
      observer?.disconnect();
      observer = undefined;
      if (typeof IntersectionObserver === "undefined") {
        validate();
        return;
      }
      observer = new IntersectionObserver((entries, currentObserver) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        currentObserver.disconnect();
        observer = undefined;
        validate();
      }, { rootMargin: "320px 0px" });
      observer.observe(node);
    };

    observe();
    return {
      update(nextPath): void {
        if (nextPath === path) return;
        path = nextPath;
        observe();
      },
      destroy(): void {
        cancelled = true;
        observer?.disconnect();
      },
    };
  }

  function linkTitle(path: string, range?: ProjectFileLineRange): string {
    if (!range) return `Preview ${path}`;
    const lines = range.startLine === range.endLine
      ? `line ${range.startLine}`
      : `lines ${range.startLine}–${range.endLine}`;
    return `Preview ${path}, ${lines}`;
  }
</script>

<div class={["whitespace-pre-wrap break-words font-mono", className]}>
  {#key text}
    {#each segments as segment, index (`${index}:${segment.text}`)}
      {#if segment.kind === "text"}
        {segment.text}
      {:else if validationStates[segment.path] === "valid"}
        <button
          class="inline cursor-pointer rounded-sm p-0 font-mono text-tool-search underline decoration-tool-search/40 underline-offset-2 hover:bg-panel-hover hover:decoration-tool-search focus-visible:outline-2 focus-visible:outline-ring"
          type="button"
          title={linkTitle(segment.path, segment.range)}
          onclick={() => void onOpenProjectFile(segment.path, segment.range)}
        >{segment.text}</button>
      {:else}
        <span
          use:lazyValidateFile={segment.path}
          class:text-muted-foreground={validationStates[segment.path] === "loading"}
        >{segment.text}</span>
      {/if}
    {/each}
  {/key}
</div>
