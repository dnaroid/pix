import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { root, run } from "./common.mjs";
import { assertMacosHelperFile, MACOS_HELPER_IDENTIFIER } from "./ui-qa-helper.mjs";

const MACH_O = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

export async function signRuntime(payload, { identity = process.env.APPLE_SIGNING_IDENTITY || "-" } = {}) {
  if (process.platform !== "darwin") return;
  const entitlements = join(root, "desktop/src-tauri/NodeEntitlements.plist");
  const node = join(payload, "runtime/node");
  // Fail closed if prepare did not bundle the UI-QA helper into this macOS payload.
  const helper = await assertMacosHelperFile(payload);
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
      const isHelper = path === helper;
      run("codesign", ["--force", "--sign", identity, "--options", "runtime",
        ...(identity === "-" ? ["--timestamp=none"] : ["--timestamp"]),
        ...(path === node ? ["--entitlements", entitlements] : []),
        // A stable identifier keeps TCC grants attached to the helper across release updates.
        ...(isHelper ? ["--identifier", MACOS_HELPER_IDENTIFIER] : []), path]);
      run("codesign", ["--verify", "--strict",
        ...(isHelper ? ["--test-requirement", `=identifier "${MACOS_HELPER_IDENTIFIER}"`] : []), path]);
    }
  }
  await visit(payload);
}
