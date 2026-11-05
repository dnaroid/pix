import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseRequest, normalizeTranscript, transcribe, runtimePaths, checkRuntime } from "./listener.mjs";
import { runProcess, waitForConsent } from "./process.mjs";

test("only explicit RU/EN file or microphone requests", () => {
    assert.deepEqual(parseRequest({ operation: "microphone", language: "ru" }), { operation: "microphone", language: "ru", seconds: 30 });
    assert.equal(parseRequest({ operation: "file", language: "en", path: "/tmp/audio.wav" }).path, "/tmp/audio.wav");
    for (const request of [null, {}, { operation: "system" }, { operation: "file", path: "/tmp/a" },
        { operation: "file", language: "auto", path: "/tmp/a" }, { operation: "file", language: "ru", path: "a" },
        { operation: "microphone", language: "ru", consent: true }, { operation: "microphone", language: "ru", seconds: 121 },
        { operation: "microphone", language: "ru", seconds: 0 }, { operation: "microphone", language: "ru", path: "/tmp/a" }]) {
        assert.throws(() => parseRequest(request));
    }
});

test("Vosk normalization preserves words; silence stays empty; invalid timing rejected", () => {
    const word = { word: "привет", start: 0, end: 0.4, conf: 0.8 };
    const raw = JSON.stringify([{ text: "привет", result: [word] }]);
    assert.equal(normalizeTranscript(raw, "ru", 1).words[0].text, "привет");
    assert.equal(normalizeTranscript('[{"text":""}]', "ru", 1).text, "");
    for (const changed of [{ start: -1 }, { end: 2 }, { conf: 2 }]) {
        assert.throws(() => normalizeTranscript(JSON.stringify([{ text: "x", result: [{ ...word, ...changed }] }]), "en", 1));
    }
});

test("consent abort rejects immediately and ignores a late approval", async () => {
    const owner = new AbortController();
    let approve;
    const pending = waitForConsent(new Promise((resolve) => { approve = resolve; }), owner.signal);
    owner.abort();
    await assert.rejects(pending, /cancelled/);
    approve(true);
    const pre = new AbortController(); pre.abort();
    await assert.rejects(waitForConsent(Promise.resolve(true), pre.signal), /cancelled/);
});

test("subprocess lifecycle: success, spawn error, limit, deadline, pre-abort, live abort", async (t) => {
    await t.test("UTF-8 chunk boundaries", async () => {
        assert.equal(await runProcess(process.execPath, ["-e", "const b=Buffer.from('привет'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),10)"]), "привет");
    });
    await t.test("missing executable", () => assert.rejects(runProcess("/no/such/listener", []), /could not start/));
    await t.test("output bound", () => assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2e6))"]), /output limit/));
    await t.test("timeout with SIGTERM ignored", () => assert.rejects(runProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { timeout: 300 }), /timed out/));
    await t.test("already cancelled never spawns", () => {
        const controller = new AbortController(); controller.abort();
        assert.throws(() => runProcess("/no/such/listener", [], { signal: controller.signal }));
    });
    await t.test("cancel active child", async () => {
        const controller = new AbortController();
        const result = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal });
        controller.abort();
        await assert.rejects(result, /cancelled/);
    });
});

test("pipeline deletes private audio on success, error and abort", async (t) => {
    await mkdir(".pi/artifacts", { recursive: true });
    const cwd = await mkdtemp(resolve(".pi/artifacts/listener-unit-"));
    const input = join(cwd, "source.wav");
    await writeFile(input, "user original");
    try {
        for (const scenario of ["success", "failure", "abort"]) await t.test(scenario, async () => {
            const controller = new AbortController();
            const run = async (_command, args) => {
                if (args[0] === "decode") { await writeFile(args[2], Buffer.alloc(32000)); return "{}"; }
                if (scenario === "failure") throw new Error("recognition failed");
                if (scenario === "abort") controller.abort();
                return '[{"text":"hello"}]';
            };
            const pending = transcribe({ operation: "file", language: "en", path: input }, { cwd, paths: runtimePaths(), signal: controller.signal, run });
            if (scenario === "success") assert.equal((await pending).text, "hello");
            else await assert.rejects(pending);
            assert.deepEqual(await readdir(join(cwd, ".pi/artifacts")), []);
            assert.ok((await readdir(cwd)).includes("source.wav"));
        });
    } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("installed native helper rejects unconfirmed mic without permission or capture", { skip: process.env.LISTENER_LOCAL_TEST !== "1" }, async () => {
    const paths = runtimePaths();
    await checkRuntime(paths);
    await assert.rejects(runProcess(paths.native, ["microphone", "1", "/invalid/output.caf"]), /process failed/);
    await assert.rejects(runProcess(paths.native, ["system", "1", "/invalid/output.caf"]), /process failed/);
});

test("real cached Vosk pipeline RU/EN with synthetic audio and network denied", { skip: !process.env.LISTENER_SYNTHETIC_FIXTURES }, async (t) => {
    const paths = runtimePaths();
    await checkRuntime(paths);
    const run = (command, args, options) => runProcess("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default) (deny network*)", command, ...args], options);
    for (const language of ["ru", "en"]) await t.test(language, async () => {
        const result = await transcribe({ operation: "file", language, path: resolve(process.env.LISTENER_SYNTHETIC_FIXTURES, `${language}.aiff`) }, {
            cwd: process.cwd(), paths, signal: new AbortController().signal, run,
        });
        assert.ok(result.text.length > 0);
        assert.ok(result.words.length > 0);
        assert.equal(result.language, language);
    });
});
