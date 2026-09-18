import { access, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { files, inside, packages } from "./payload-files.mjs";
import { foreignPackage } from "./prune.mjs";

const MIB = 1024 * 1024;
export const budgets = {
  tui: { unpacked: 384 * MIB, archive: 160 * MIB },
  desktop: { unpacked: 512 * MIB, archive: 240 * MIB },
};

export function assertBudget(size, variant, kind) {
  const limit = budgets[variant]?.[kind];
  if (!limit || !Number.isSafeInteger(size) || size < 0) throw new Error("Invalid release size measurement");
  if (size > limit) throw new Error(`${variant} ${kind} exceeds size budget: ${(size / MIB).toFixed(1)} MiB > ${limit / MIB} MiB`);
}

export async function auditPayload(payload, target, variant) {
  if (!budgets[variant]) throw new Error(`Unknown release variant: ${variant}`);
  const root = await realpath(payload);
  let size = 0, count = 0;
  const sections = {};
  for await (const { path, stat: entry } of files(root)) {
    const name = relative(root, path).replaceAll("\\", "/");
    if (/(^|\/)models\/vosk(\/|$)/u.test(name)) throw new Error(`Legacy Vosk in release: ${name}`);
    if (variant === "tui" && name.startsWith("app/acp/")) throw new Error("TUI must not include the Desktop ACP payload");
    if (entry.isSymbolicLink()) {
      const destination = resolve(dirname(path), await readlink(path));
      if (!inside(root, destination) || !inside(root, await realpath(destination))) throw new Error(`Non-portable link: ${name}`);
      continue;
    }
    size += entry.size; count++;
    let section = name.split("/")[0];
    if (name.startsWith("app/node_modules/")) section = "pixDependencies";
    else if (name.startsWith("app/acp/node_modules/")) section = "acpDependencies";
    else if (name.startsWith("app/")) section = "application";
    sections[section] = (sections[section] ?? 0) + entry.size;
  }
  const installed = [...await packages(join(root, "app"))];
  if (variant === "desktop") {
    await access(join(root, "app/acp/dist/main.js"));
    installed.push(...await packages(join(root, "app/acp")));
  }
  for (const pkg of installed) {
    if (foreignPackage(pkg.manifest.name ?? "", target)) throw new Error(`Foreign platform package in release: ${pkg.path}`);
  }
  assertBudget(size, variant, "unpacked");
  return { variant, fileBytes: size, fileCount: count, sections, limitBytes: budgets[variant].unpacked };
}

export async function recordSize(payload, target, variant) {
  const report = await auditPayload(payload, target, variant);
  await writeFile(join(payload, "SIZE.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${variant} payload: ${(report.fileBytes / MIB).toFixed(1)} MiB (${report.fileCount} files)`);
  return report;
}

export async function checkArchive(path, variant) {
  const { size } = await stat(path);
  assertBudget(size, variant, "archive");
  console.log(`${variant} download: ${(size / MIB).toFixed(1)} MiB`);
  return size;
}
