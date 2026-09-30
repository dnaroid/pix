import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Hydrate trusted fenced-code markup; never derive clipboard text from token DOM. */
export function createMarkdownCodeCopyAction(iconTemplate: () => HTMLSpanElement | undefined) {
  return function codeCopy(node: HTMLElement, _html: string) {
    let generation = 0;
    let destroyed = false;
    const cleanups: (() => void)[] = [];

    function clear() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    }

    function schedule() {
      clear();
      const current = ++generation;
      queueMicrotask(() => {
        if (destroyed || current !== generation) return;
        for (const block of node.querySelectorAll<HTMLElement>("pre[data-code-source]")) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "markdown-code-copy";
          button.title = "Copy code";
          button.setAttribute("aria-label", "Copy code");
          const icon = iconTemplate()?.querySelector("svg")?.cloneNode(true) as SVGElement | undefined;
          if (icon) {
            icon.setAttribute("aria-hidden", "true");
            button.append(icon);
          }
          const status = document.createElement("span");
          status.setAttribute("aria-live", "polite");
          button.append(status);
          block.append(button);
          let timer: ReturnType<typeof setTimeout> | undefined;
          async function onClick(): Promise<void> {
            if (button.disabled) return;
            if (timer) clearTimeout(timer);
            button.disabled = true;
            status.textContent = "";
            delete button.dataset.state;
            let copied = false;
            try {
              await writeText(block.dataset.codeSource ?? "");
              copied = true;
            } catch {
              // Clipboard errors are local to this button, not the transcript.
            }
            if (destroyed || current !== generation || !node.contains(button)) return;
            status.textContent = copied ? "Copied" : "Copy failed";
            button.dataset.state = copied ? "copied" : "error";
            button.disabled = false;
            timer = setTimeout(() => {
              status.textContent = "";
              delete button.dataset.state;
            }, 2000);
          }
          button.addEventListener("click", onClick);
          cleanups.push(() => {
            if (timer) clearTimeout(timer);
            button.removeEventListener("click", onClick);
            button.remove();
          });
        }
      });
    }

    schedule();
    return {
      update: schedule,
      destroy() {
        destroyed = true;
        generation += 1;
        clear();
      },
    };
  };
}
