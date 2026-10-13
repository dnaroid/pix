// Copied into release payloads alongside verify.mjs; use only Node built-ins.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";

// Inventory avoids recursively walking the dependency tree during Windows smoke.
export function verifyEsbuildInventory(app, inventory) {
  const appRoot = resolve(app);
  const require = createRequire(join(appRoot, "package.json"));
  const directories = new Set();
  for (const entry of inventory) {
    if (entry?.name !== "esbuild" || typeof entry.path !== "string") continue;
    const packageJson = resolve(appRoot, entry.path);
    assert.ok(packageJson.startsWith(`${appRoot}${sep}`), `Unsafe dependency inventory path: ${entry.path}`);
    directories.add(dirname(packageJson));
  }
  // SDK 1.2 uses jiti without production esbuild. Absence is valid; retained
  // instances still have to prove their native binary works.
  for (const directory of directories) {
    const esbuild = require(directory);
    try {
      const result = esbuild.transformSync("const value: number = 42", { loader: "ts" });
      assert.match(result.code, /42/u);
    } finally {
      esbuild.stop();
    }
  }
  return directories.size;
}
