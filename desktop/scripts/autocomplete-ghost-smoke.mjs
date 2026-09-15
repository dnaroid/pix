import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "autocomplete-ghost-smoke-fixture",
    configureServer(vite) {
      vite.middlewares.use("/__autocomplete-ghost-test__", (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end('<!doctype html><html><head><title>Autocomplete ghost smoke</title></head><body><div id="app"></div></body></html>');
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 427, height: 180 } });
  await page.goto(`http://127.0.0.1:${address.port}/__autocomplete-ghost-test__`);
  const geometry = await page.evaluate(async () => {
    await import("/src/styles.css");
    const { syncPromptGhostLayer } = await import("/src/components/prompt-composer-textarea-controller.svelte.ts");
    document.querySelector("#app").innerHTML = `
      <div class="text-sm" style="width: 360px">
        <div class="relative min-w-0 flex-1" id="host">
          <div id="ghost" class="pointer-events-none absolute inset-0 overflow-hidden px-0.5 leading-relaxed whitespace-pre-wrap break-words"><span class="text-transparent">какая у нас модель для эмбеддинга картинок?</span><span class="text-muted-foreground/45"> сколько контекста занимает одна картинка?</span></div>
          <textarea id="draft" class="relative z-10 block min-h-6 w-full resize-none overflow-y-hidden border-0 bg-transparent px-0.5 leading-relaxed text-foreground outline-none" rows="1">какая у нас модель для эмбеддинга картинок?</textarea>
        </div>
      </div>`;
    const textarea = document.querySelector("#draft");
    const ghost = document.querySelector("#ghost");
    syncPromptGhostLayer(textarea, ghost);
    const textareaStyle = getComputedStyle(textarea);
    const ghostStyle = getComputedStyle(ghost);
    return {
      textarea: {
        paddingTop: textareaStyle.paddingTop,
        paddingBottom: textareaStyle.paddingBottom,
        paddingLeft: textareaStyle.paddingLeft,
        paddingRight: textareaStyle.paddingRight,
        fontFamily: textareaStyle.fontFamily,
        fontSize: textareaStyle.fontSize,
        fontWeight: textareaStyle.fontWeight,
        letterSpacing: textareaStyle.letterSpacing,
        lineHeight: textareaStyle.lineHeight,
        whiteSpace: textareaStyle.whiteSpace,
        overflowWrap: textareaStyle.overflowWrap,
      },
      ghost: {
        paddingTop: ghostStyle.paddingTop,
        paddingBottom: ghostStyle.paddingBottom,
        paddingLeft: ghostStyle.paddingLeft,
        paddingRight: ghostStyle.paddingRight,
        fontFamily: ghostStyle.fontFamily,
        fontSize: ghostStyle.fontSize,
        fontWeight: ghostStyle.fontWeight,
        letterSpacing: ghostStyle.letterSpacing,
        lineHeight: ghostStyle.lineHeight,
        whiteSpace: ghostStyle.whiteSpace,
        overflowWrap: ghostStyle.overflowWrap,
      },
    };
  });
  assert.deepEqual(geometry.ghost, geometry.textarea);
  console.log("PASS: autocomplete ghost typography and wrapping metrics match the textarea");
} finally {
  await browser?.close();
  await server.close();
}
