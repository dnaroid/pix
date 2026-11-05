import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const { VOSK_PROBE_BIN, VOSK_LIBRARY, VOSK_MODEL_ROOT, LISTENER_FIXTURE_DIR } = process.env;
const enabled = !!(VOSK_PROBE_BIN && VOSK_LIBRARY && VOSK_MODEL_ROOT && LISTENER_FIXTURE_DIR);
const references = {
	ru: "это проверка распознавания речи сегодня хорошая погода один два три четыре пять",
	en: "this is a speech recognition test the weather is good today one two three four five",
};
const models = { ru: "vosk-model-small-ru-0.22", en: "vosk-model-small-en-us-0.15" };

function args(language, input) {
	return ["-p", "(version 1)(allow default)(deny network*)", resolve(VOSK_PROBE_BIN),
		resolve(VOSK_LIBRARY), join(VOSK_MODEL_ROOT, models[language]), input];
}

function recognize(language, input) {
	const result = spawnSync("/usr/bin/sandbox-exec", args(language, input), { encoding: "utf8", timeout: 15000 });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

test("Vosk arm64 feasibility with cached models and network denied", { skip: !enabled }, async (t) => {
	const run = mkdtempSync(resolve(".pi/artifacts/listener-vosk-tests-"));
	for (const language of ["ru", "en"]) {
		await t.test(`${language}: known synthesized speech and monotonic word timestamps`, () => {
			const results = recognize(language, join(LISTENER_FIXTURE_DIR, `${language}.pcm`));
			assert.equal(results.map((part) => part.text).join(" ").trim(), references[language]);
			let previousEnd = 0;
			const words = results.flatMap((part) => part.result ?? []);
			assert.ok(words.length > 0);
			for (const word of words) {
				assert.ok(word.start >= previousEnd && word.end > word.start && word.end <= 120);
				assert.ok(word.conf >= 0 && word.conf <= 1);
				previousEnd = word.end;
			}
		});
		await t.test(`${language}: silence never becomes invented speech`, () => {
			const input = join(run, `${language}-silence.pcm`);
			writeFileSync(input, Buffer.alloc(32000));
			const results = recognize(language, input);
			assert.equal(results.map((part) => part.text).join("").trim(), "");
		});
	}
	await t.test("SIGTERM after handler readiness cancels without a final transcript", async () => {
		const child = spawn("/usr/bin/sandbox-exec", args("ru", join(LISTENER_FIXTURE_DIR, "ru.pcm")), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let sent = false;
		const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
		try {
			child.stdout.on("data", (data) => { stdout += data; });
			child.stderr.on("data", (data) => {
				stderr += data;
				if (!sent && stderr.includes("VOSK_PROBE_READY")) {
					sent = true;
					child.kill("SIGTERM");
				}
			});
			const [code, signal] = await new Promise((resolveExit, reject) => {
				child.on("error", reject);
				child.on("close", (code, signal) => resolveExit([code, signal]));
			});
			assert.ok(sent);
			assert.equal(signal, null);
			assert.equal(code, 130);
			assert.equal(stdout, "");
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	});
});
