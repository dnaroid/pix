import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./node-runtime.mjs";
import { targets, version } from "./common.mjs";

export function expectedBuildAssets(releaseVersion) {
  return Object.keys(targets).flatMap((target) => {
    const extensions = target.startsWith("windows") ? ["-setup.exe", "-setup.exe.sig"]
      : target.startsWith("macos") ? [".dmg", "-updater.tar.gz", "-updater.tar.gz.sig"]
        : [".AppImage", ".AppImage.sig", ".deb"];
    return [`pix-tui-${releaseVersion}-${target}.${target.startsWith("windows") ? "zip" : "tar.gz"}`,
      ...extensions.map((extension) => `pix-desktop-${releaseVersion}-${target}${extension}`)];
  }).sort();
}

export function expectedPublishedAssets(releaseVersion) {
  return [...expectedBuildAssets(releaseVersion).filter((file) => !file.endsWith(".sig")), "latest.json"].sort();
}

function releaseUrl(releaseVersion, name) {
  return `https://github.com/dnaroid/pix/releases/download/v${releaseVersion}/${name}`;
}

async function signature(directory, name) {
  const value = (await readFile(join(directory, name), "utf8")).trim();
  if (!value) throw new Error(`Empty updater signature: ${name}`);
  return value;
}

export async function latestJson(directory, releaseVersion) {
  const asset = {
    linux: `pix-desktop-${releaseVersion}-linux-x64.AppImage`,
    windows: `pix-desktop-${releaseVersion}-windows-x64-setup.exe`,
    macArm: `pix-desktop-${releaseVersion}-macos-arm64-updater.tar.gz`,
  };
  const data = {
    version: releaseVersion,
    notes: `Pix ${releaseVersion}. See the GitHub Release for full notes.`,
    platforms: {
      "linux-x86_64": { url: releaseUrl(releaseVersion, asset.linux), signature: await signature(directory, `${asset.linux}.sig`) },
      "windows-x86_64": { url: releaseUrl(releaseVersion, asset.windows), signature: await signature(directory, `${asset.windows}.sig`) },
      "darwin-aarch64": { url: releaseUrl(releaseVersion, asset.macArm), signature: await signature(directory, `${asset.macArm}.sig`) },
    },
  };
  await writeFile(join(directory, "latest.json"), `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

export async function checksums(directory, releaseVersion) {
  const buildFiles = (await readdir(directory)).filter((file) => file !== "SHA256SUMS" && file !== "latest.json").sort();
  const expectedBuild = expectedBuildAssets(releaseVersion);
  if (JSON.stringify(buildFiles) !== JSON.stringify(expectedBuild)) {
    throw new Error(`Incomplete/unexpected release assets. Expected ${expectedBuild.join(", ")}; got ${buildFiles.join(", ")}`);
  }
  await latestJson(directory, releaseVersion);
  const files = expectedPublishedAssets(releaseVersion);
  for (const file of files) {
    try {
      await readFile(join(directory, file));
    } catch {
      throw new Error(`Missing public release asset after manifest generation: ${file}`);
    }
  }
  const lines = [];
  for (const file of files) lines.push(`${await sha256(join(directory, file))}  ${file}`);
  await writeFile(join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: checksums.mjs <merged-assets-directory>");
  await checksums(resolve(process.argv[2]), version());
}
