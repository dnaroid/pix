import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, root, run, version } from "./common.mjs";

export function versionEdits(directory, next) {
  // Installer-compatible stable versions. Prerelease distribution can be added with an explicit MSI policy.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(next)) throw new Error("Release version must be stable X.Y.Z");
  const [major, minor, patch] = next.split(".").map(Number);
  if (major > 255 || minor > 255 || patch > 65535) throw new Error("Version exceeds Windows MSI limits");
  const edits = new Map();
  for (const prefix of ["", "acp/", "desktop/"]) {
    for (const file of ["package.json", "package-lock.json"]) {
      if (!prefix && file === "package.json") continue;
      const path = `${prefix}${file}`;
      const original = readFileSync(join(directory, path), "utf8");
      const data = JSON.parse(original);
      data.version = next;
      if (file === "package-lock.json") data.packages[""].version = next;
      const indent = original.includes('\n\t"') ? "\t" : 2;
      edits.set(path, `${JSON.stringify(data, null, indent)}\n`);
    }
  }
  const config = readJson(join(directory, "desktop/src-tauri/tauri.conf.json"));
  config.version = next;
  edits.set("desktop/src-tauri/tauri.conf.json", `${JSON.stringify(config, null, 2)}\n`);
  for (const file of ["Cargo.toml", "Cargo.lock"]) {
    const path = `desktop/src-tauri/${file}`;
    const text = readFileSync(join(directory, path), "utf8");
    const pattern = /(\bname = "pix-desktop"\r?\nversion = ")[^"]+("\r?\n)/u;
    if (!pattern.test(text)) throw new Error(`Cannot locate Pix version in ${path}`);
    edits.set(path, text.replace(pattern, (_match, before, after) => `${before}${next}${after}`));
  }
  return edits;
}

export function syncVersion({ check = false, stage = false, tag } = {}) {
  const next = version();
  if (tag !== undefined && tag !== `v${next}`) throw new Error(`Tag ${tag} does not match v${next}`);
  const edits = versionEdits(root, next);
  const changed = [...edits].filter(([path, text]) => readFileSync(join(root, path), "utf8") !== text);
  if (check && changed.length) throw new Error(`Version drift: ${changed.map(([path]) => path).join(", ")}. Run npm run release:version.`);
  for (const [path, text] of changed) writeFileSync(join(root, path), text);
  // npm's version lifecycle runs BEFORE its commit/tag, so all manifests enter the same release commit.
  if (stage) run("git", ["add", "--", ...edits.keys()]);
  return next;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  for (const arg of args) if (!["--check", "--stage", "--tag"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
  syncVersion({ check: args.includes("--check"), stage: args.includes("--stage"),
    ...(args.includes("--tag") ? { tag: process.env.GITHUB_REF_NAME ?? "" } : {}) });
}
