<script lang="ts">
  import { tick, type Snippet } from "svelte";

  let { label, trigger, children, onOpen = () => {} }: {
    label: string;
    trigger: Snippet<[{ open: boolean; toggle: (event: MouseEvent) => void; id: string }]>;
    children: Snippet;
    onOpen?: () => void;
  } = $props();

  const id = $props.id();
  let root = $state<HTMLDivElement>();
  let invoker: HTMLButtonElement | undefined;
  let open = $state(false);

  function close(restoreFocus = false): void {
    if (!open) return;
    if (restoreFocus) invoker?.focus();
    open = false;
  }

  async function toggle(event: MouseEvent): Promise<void> {
    invoker = event.currentTarget as HTMLButtonElement;
    open = !open;
    if (open) {
      await tick();
      if (open && root?.isConnected) onOpen();
    }
  }

  function outside(event: PointerEvent): void {
    if (event.target instanceof Node && !root?.contains(event.target)) close();
  }

  function keydown(event: KeyboardEvent): void {
    if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }

  function focusout(event: FocusEvent): void {
    if (!(event.relatedTarget instanceof Node) || !root?.contains(event.relatedTarget)) close();
  }
</script>

<svelte:window onpointerdown={outside} onkeydown={keydown} />

<div bind:this={root} class="relative shrink-0" role="group" aria-label={label} onfocusout={focusout}>
  {@render trigger({ open, toggle, id })}
  <div {id} hidden={!open} role="dialog" aria-label={label} tabindex="0"
    class="absolute right-0 bottom-full z-40 max-h-[max(0px,calc(100dvh-70px))] w-80 max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain">
    {@render children()}
  </div>
</div>
