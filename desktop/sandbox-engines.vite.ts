import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rolldown } from "rolldown";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);
const prefix = "virtual:pix-sandbox-";

/** Build guest-only scripts as inert strings, never as host-side engine code. */
export function sandboxEngines(): Plugin {
  const sources = new Map<string, Promise<string>>();
  async function engineUrl(engine: string): Promise<string> {
    let code: string;
    if (engine === "phaser") {
      code = await readFile(require.resolve("phaser/dist/phaser.min.js"), "utf8");
    } else {
      const buildDir = dirname(require.resolve("three"));
      const bundle = await rolldown({
        input: join(buildDir, "three.module.js"), platform: "browser",
      });
      try {
        const { output } = await bundle.generate({ format: "iife", name: "THREE", minify: true });
        const chunk = output.find((item) => item.type === "chunk");
        if (!chunk || output.length !== 1) throw new Error("Three.js must be a single offline script.");
        // Preserve the upstream license in the distributed guest script.
        const license = await readFile(join(buildDir, "..", "LICENSE"), "utf8");
        code = `/* ${license} */\n${chunk.code}`;
      } finally {
        await bundle.close();
      }
    }
    // Encoding happens in Node at build/dev time, not on the UI thread on Run.
    return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  }
  return {
    name: "pix-offline-sandbox-engines",
    resolveId(id) {
      if (id === `${prefix}phaser` || id === `${prefix}three`) return `\0${id}`;
    },
    async load(id) {
      if (!id.startsWith(`\0${prefix}`)) return;
      const engine = id.slice(prefix.length + 1);
      let source = sources.get(engine);
      if (!source) {
        source = engineUrl(engine);
        sources.set(engine, source);
      }
      try {
        return `export default ${JSON.stringify(await source)};`;
      } catch (error) {
        sources.delete(engine);
        throw error;
      }
    },
  };
}
