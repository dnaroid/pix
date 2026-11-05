import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { discoverAndLoadExtensions, loadExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

async function load() {
    const result = await loadExtensions([resolve("scripts/audio-listener/extension.ts")], process.cwd());
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    assert.deepEqual([...extension.tools.keys()], ["listener"]);
    return { extension, tool: extension.tools.get("listener").definition };
}

test("project-local entry is discovered and loads through the installed SDK", async () => {
    await load();
    await mkdir(".pi/artifacts", { recursive: true });
    const agentDir = await mkdtemp(resolve(".pi/artifacts/listener-discovery-test-"));
    try {
        const project = join(agentDir, "project");
        await mkdir(join(project, ".pi/extensions"), { recursive: true });
        await writeFile(join(project, ".pi/extensions/listener.ts"),
            `export { default } from ${JSON.stringify(resolve("scripts/audio-listener/extension.ts"))};\n`);
        const result = await discoverAndLoadExtensions([], project, agentDir);
        assert.deepEqual(result.errors, []);
        assert.ok(result.extensions.some((extension) => extension.tools.has("listener")));
    } finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("tool consent and session lifecycle (fake native helpers, never captures)", { skip: process.env.LISTENER_LOCAL_TEST !== "1" }, async (t) => {
    const home = await mkdtemp(resolve(".pi/artifacts/listener-extension-test-"));
    const marker = join(home, "unexpected-spawn");
    const oldHome = process.env.PIX_LISTENER_HOME;
    process.env.PIX_LISTENER_HOME = home;
    try {
        for (const name of ["listener-native", "vosk-runner"]) {
            await writeFile(join(home, name), `#!/bin/sh\nprintf unexpected > '${marker}'\nexit 77\n`, { mode: 0o700 });
        }
        await writeFile(join(home, "libvosk.dylib"), "stub");
        const request = { operation: "microphone", language: "ru", seconds: 1 };
        const context = (confirm, hasUI = true) => ({ cwd: process.cwd(), hasUI, ui: { confirm } });
        await t.test("decline and no UI never invoke native capture", async () => {
            const { tool } = await load();
            await assert.rejects(tool.execute("id", request, undefined, undefined, context(async () => false)), /declined/);
            await assert.rejects(tool.execute("id", request, undefined, undefined, context(() => assert.fail("dialog in headless mode"), false)), /interactive/);
        });
        for (const reason of ["abort", "session_before_switch", "session_shutdown"]) await t.test(`late consent after ${reason} is ignored`, async () => {
            const { tool, extension } = await load();
            const owner = new AbortController();
            let approve, entered;
            const ready = new Promise((resolve) => { entered = resolve; });
            const ctx = context(() => { entered(); return new Promise((resolve) => { approve = resolve; }); });
            const pending = tool.execute("id", request, owner.signal, undefined, ctx);
            const rejected = assert.rejects(pending, /cancelled/);
            await ready;
            await assert.rejects(tool.execute("second", { operation: "status" }, undefined, undefined, ctx), /busy/);
            if (reason === "abort") owner.abort();
            else for (const handler of extension.handlers.get(reason)) await handler({ type: reason }, ctx);
            await rejected;
            approve(true);
            await new Promise((resolve) => setImmediate(resolve));
            if (reason === "session_shutdown") {
                await assert.rejects(tool.execute("status", { operation: "status" }, undefined, undefined, ctx), /closed/);
            } else {
                const result = await tool.execute("status", { operation: "status" }, undefined, undefined, ctx);
                assert.match(result.content[0].text, /ready/);
            }
        });
        await assert.rejects(readFile(marker), { code: "ENOENT" });
        await t.test("shutdown waits for child exit and private audio cleanup", async () => {
            await writeFile(join(home, "listener-native"), `#!${process.execPath}\nimport fs from 'node:fs';
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150));
fs.writeFileSync(process.argv[4], Buffer.alloc(320));
fs.writeFileSync(${JSON.stringify(marker)}, process.argv[4]);
setInterval(()=>{},1000);\n`, { mode: 0o700 });
            const source = join(home, "input.wav");
            await writeFile(source, "synthetic stub input");
            const { tool, extension } = await load();
            const ctx = context(() => assert.fail("file must not prompt"));
            const owner = new AbortController();
            const outcome = tool.execute("file", { operation: "file", language: "en", path: source }, owner.signal, undefined, ctx)
                .then(() => ({ error: new Error("unexpected success") }), (error) => ({ error }));
            try {
                let output;
                const deadline = Date.now() + 5000;
                while (!output && Date.now() < deadline) {
                    try { output = await readFile(marker, "utf8"); }
                    catch (error) { if (error.code !== "ENOENT") throw error; }
                    if (!output) await new Promise((resolve) => setTimeout(resolve, 20));
                }
                assert.ok(output, "fake child started");
                for (const handler of extension.handlers.get("session_shutdown")) await handler({ type: "session_shutdown" }, ctx);
                await assert.rejects(readFile(output), { code: "ENOENT" });
                await assert.rejects(readFile(dirname(output)), { code: "ENOENT" });
            } finally {
                owner.abort();
                assert.match((await outcome).error.message, /cancelled|aborted/);
            }
        });
    } finally {
        if (oldHome === undefined) delete process.env.PIX_LISTENER_HOME;
        else process.env.PIX_LISTENER_HOME = oldHome;
        await rm(home, { recursive: true, force: true });
    }
});
