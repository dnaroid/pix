import { join } from "node:path";
import { hostTarget, outputPaths, run, targetInfo, version } from "./common.mjs";
import { prepare } from "./prepare.mjs";
import { signRuntime } from "./sign-runtime.mjs";
import { smokeArchive } from "./smoke.mjs";
import { buildDesktop } from "./build-desktop.mjs";
import { checkArchive, recordSize } from "./size-budget.mjs";

const args = process.argv.slice(2);
const name = args.find((arg) => !arg.startsWith("--")) ?? hostTarget();
for (const arg of args) if (arg !== name && arg !== "--tui-only") throw new Error(`Unknown argument: ${arg}`);
const target = targetInfo(name);
const { work, payload, desktopPayload, assets } = outputPaths(name);
const withDesktop = !args.includes("--tui-only");
await prepare(name, { withDesktop });
await signRuntime(payload);
await recordSize(payload, target, "tui");
const archive = join(assets, `pix-tui-${version()}-${name}.${process.platform === "win32" ? "zip" : "tar.gz"}`);
if (process.platform === "win32") run("tar", ["-a", "-cf", archive, "-C", work, "pix"]);
else run("tar", ["-czf", archive, "-C", work, "pix"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
await checkArchive(archive, "tui");
await smokeArchive(name);

if (withDesktop) {
  await signRuntime(desktopPayload);
  await recordSize(desktopPayload, target, "desktop");
  await buildDesktop(name);
}
console.log(`Release assets: ${assets}`);
