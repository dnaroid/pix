import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
// @ts-expect-error Node fs import in Vitest runner (frontend tsconfig omits Node globals)
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
// @ts-expect-error Node os import in Vitest runner
import { tmpdir } from "node:os";
// @ts-expect-error Node path import in Vitest runner
import { join } from "node:path";
// @ts-expect-error Node url import in Vitest runner
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("discovers frontend utilities without scanning native or generated artifacts", async () => {
  const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
  const stylesheet = await readFile(join(sourceDirectory, "styles.css"), "utf8");
  const compiler = await compile(stylesheet, { base: sourceDirectory, onDependency() {} });
  // Otherwise the Vite plugin adds the whole project as an automatic source.
  expect(compiler.root).toBe("none");

  const root = await realpath(await mkdtemp(join(tmpdir(), "pix-tailwind-sources-")));
  try {
    const src = join(root, "src");
    const target = join(root, "src-tauri", "target");
    const dist = join(root, "dist");
    await Promise.all([mkdir(src), mkdir(target, { recursive: true }), mkdir(dist)]);
    await Promise.all([
      writeFile(join(src, "Panel.svelte"), '<div class="flex hover:bg-primary"></div>'),
      writeFile(join(root, "index.html"), '<div class="grid"></div>'),
      writeFile(join(target, "native.html"), '<div class="m-[987654px]"></div>'),
      writeFile(join(dist, "bundle.js"), 'const unused = "p-[987654px]";'),
    ]);
    const scanner = new Scanner({
      sources: compiler.sources.map((source) => ({ ...source, base: src })),
    });
    const css = compiler.build(scanner.scan());
    expect(css).toContain(".flex");
    expect(css).toContain(".grid");
    expect(css).toContain(".hover\\:bg-primary");
    expect(css).not.toContain("987654px");
    expect(scanner.files.sort()).toEqual([join(root, "index.html"), join(src, "Panel.svelte")].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
