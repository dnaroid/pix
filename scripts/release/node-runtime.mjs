import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nodeVersion, root, run } from "./common.mjs";

export function nodeArchive(version, platform, arch) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Node pin must be an exact stable version");
  if (!["darwin/arm64", "darwin/x64", "linux/x64", "win32/x64"].includes(`${platform}/${arch}`)) {
    throw new Error(`Unsupported Node target: ${platform}/${arch}`);
  }
  const stem = `node-v${version}-${platform === "win32" ? "win" : platform}-${arch}`;
  return { stem, filename: `${stem}.${platform === "win32" ? "zip" : "tar.gz"}` };
}

export function expectedDigest(sums, filename) {
  const entries = sums.split(/\r?\n/u).map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/u.exec(line))
    .filter((entry) => entry?.[2] === filename);
  if (entries.length !== 1) throw new Error(`Missing or ambiguous official checksum: ${filename}`);
  return entries[0][1];
}

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function download(url, path) {
  const response = await fetch(url, { signal: AbortSignal.timeout(240_000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, { flags: "wx" }));
}

export async function installNode(payload, target) {
  const pin = nodeVersion();
  const { stem, filename } = nodeArchive(pin, target.platform, target.arch);
  const base = `https://nodejs.org/dist/v${pin}`;
  const parent = join(root, ".artifacts/release-downloads");
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(join(parent, "node-"));
  try {
    const sums = join(scratch, "SHASUMS256.txt");
    const archive = join(scratch, filename);
    await download(`${base}/SHASUMS256.txt`, sums);
    const expected = expectedDigest(await readFile(sums, "utf8"), filename);
    await download(`${base}/${filename}`, archive);
    if (await sha256(archive) !== expected) throw new Error(`Node checksum mismatch: ${filename}`);
    // BSD tar on Windows supports zip as well as tar.gz.
    run("tar", ["-xf", archive, "-C", scratch]);
    const runtime = join(payload, "runtime");
    await mkdir(runtime, { recursive: true });
    const executable = join(runtime, target.platform === "win32" ? "node.exe" : "node");
    await copyFile(join(scratch, stem, target.platform === "win32" ? "node.exe" : "bin/node"), executable);
    await chmod(executable, 0o755);
    await copyFile(join(scratch, stem, "LICENSE"), join(runtime, "LICENSE"));
    return { version: pin, filename, sha256: expected };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}
