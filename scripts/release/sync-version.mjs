import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, root, run, version } from "./common.mjs";

function stringifyJsonLike(original, data) {
  const indent = original.includes('\n\t"') || original.includes('\r\n\t"') ? "\t" : 2;
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  return `${JSON.stringify(data, null, indent).replaceAll("\n", eol)}${eol}`;
}

export function versionEdits(directory, next) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(next)) throw new Error("Release version must be stable X.Y.Z");
  const edits = new Map();
  for (const prefix of ["", "acp/", "desktop/"]) {
    for (const file of ["package.json", "package-lock.json"]) {
      if (!prefix && file === "package.json") continue;
      const path = `${prefix}${file}`;
      const original = readFileSync(join(directory, path), "utf8");
      const data = JSON.parse(original);
      data.version = next;
      if (file === "package-lock.json") data.packages[""].version = next;
      edits.set(path, stringifyJsonLike(original, data));
    }
  }
  const configPath = join(directory, "desktop/src-tauri/tauri.conf.json");
  const configOriginal = readFileSync(configPath, "utf8");
  const config = JSON.parse(configOriginal);
  config.version = next;
  edits.set("desktop/src-tauri/tauri.conf.json", stringifyJsonLike(configOriginal, config));
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
