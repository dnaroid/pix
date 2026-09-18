import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { root, run } from "./common.mjs";

const MACH_O = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

export async function signRuntime(payload) {
  if (process.platform !== "darwin") return;
  const identity = process.env.APPLE_SIGNING_IDENTITY || "-";
  const entitlements = join(root, "desktop/src-tauri/NodeEntitlements.plist");
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) continue;
      const handle = await open(path, "r");
      const magic = Buffer.alloc(4);
      try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
      if (!MACH_O.has(magic.toString("hex"))) continue;
      run("codesign", ["--force", "--sign", identity, "--options", "runtime",
        ...(identity === "-" ? ["--timestamp=none"] : ["--timestamp"]),
        ...(path === join(payload, "runtime/node") ? ["--entitlements", entitlements] : []), path]);
      run("codesign", ["--verify", "--strict", path]);
    }
  }
  await visit(payload);
}
