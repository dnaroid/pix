import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePaths, checkRuntime } from "./listener.mjs";

const exec = promisify(execFile);
const source = dirname(fileURLToPath(import.meta.url));
const root = resolve(source, "../..");
const probe = join(root, "scripts/audio-listener-probe");
if (process.argv.length !== 3 || process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Usage (macOS arm64 + Xcode CLI tools): node scripts/audio-listener/setup.mjs OFFICIAL_VOSK_ZIP");
}
const archive = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(probe, "vosk-artifacts.json"), "utf8"));
const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
if (digest !== manifest.runtime.sha256) throw new Error("Official Vosk archive checksum mismatch");
await mkdir(join(root, ".pi/artifacts"), { recursive: true });
const work = await mkdtemp(join(root, ".pi/artifacts/listener-build-"));
const paths = runtimePaths();
const target = dirname(paths.native);
let createdTarget = false;
try {
    for (const name of ["libvosk.dylib", "vosk_api.h"]) {
        const { stdout } = await exec("/usr/bin/unzip", ["-p", archive, `vosk-osx-0.3.42/${name}`], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
        await writeFile(join(work, name), stdout, { mode: 0o600 });
    }
    const swift = ["Native.swift"].map((name) => join(source, name));
    for (const name of ["Decode", "DecodeReference", "MicrophoneCapture", "CaptureLifetime", "CapturePermission", "CaptureCompletion"]) swift.push(join(probe, `${name}.swift`));
    await exec("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-target", "arm64-apple-macosx13.5", ...swift,
        "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", join(probe, "Info.plist"), "-o", join(work, "listener-native")]);
    await exec("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "dev.pix.local-listener", join(work, "listener-native")]);
    await exec("/usr/bin/xcrun", ["clang", "-arch", "arm64", "-mmacosx-version-min=13.5", "-I", work, join(probe, "vosk-probe.c"), "-o", join(work, "vosk-runner")]);
    await mkdir(dirname(target), { recursive: true });
    // Refuse to replace an installation that another session might be using.
    await mkdir(target, { mode: 0o700 });
    createdTarget = true;
    for (const name of ["listener-native", "vosk-runner", "libvosk.dylib"]) await copyFile(join(work, name), join(target, name), constants.COPYFILE_EXCL);
    await checkRuntime(paths);
    console.log(`Local listener installed: ${target}. Cached RU/EN models found; no downloads.`);
} catch (error) {
    if (createdTarget) await rm(target, { recursive: true, force: true });
    throw error;
} finally {
    await rm(work, { recursive: true, force: true });
}
