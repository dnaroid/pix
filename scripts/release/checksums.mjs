import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./node-runtime.mjs";
import { targets, version } from "./common.mjs";

export function expectedAssets(releaseVersion) {
  return Object.keys(targets).flatMap((target) => {
    const extensions = target.startsWith("windows") ? ["-setup.exe", ".msi"]
      : target.startsWith("macos") ? [".dmg"] : [".AppImage", ".deb"];
    return [`pix-tui-${releaseVersion}-${target}.${target.startsWith("windows") ? "zip" : "tar.gz"}`,
      ...extensions.map((extension) => `pix-desktop-${releaseVersion}-${target}${extension}`)];
  }).sort();
}

export async function checksums(directory, releaseVersion) {
  const files = (await readdir(directory)).filter((file) => file !== "SHA256SUMS").sort();
  const expected = expectedAssets(releaseVersion);
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`Incomplete/unexpected release assets. Expected ${expected.join(", ")}; got ${files.join(", ")}`);
  }
  const lines = [];
  for (const file of files) lines.push(`${await sha256(join(directory, file))}  ${file}`);
  await writeFile(join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: checksums.mjs <merged-assets-directory>");
  await checksums(resolve(process.argv[2]), version());
}
