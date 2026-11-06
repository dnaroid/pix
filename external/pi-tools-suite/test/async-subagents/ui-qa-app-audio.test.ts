import { describe, expect, test } from "bun:test";
import { appAudioEvidence, validateAppAudioPolicy } from "../../src/async-subagents/agents/ui-qa/backends/app-audio.mjs";

describe("app audio consent and evidence", () => {
	test("defaults to silent and requires explicit boolean desktop opt-in", () => {
		expect(validateAppAudioPolicy({})).toBeUndefined();
		expect(validateAppAudioPolicy({ target: { application: { pid: 123 } }, recordAppAudio: true })).toBeUndefined();
		for (const recordAppAudio of [null, 1, "true", {}]) {
			expect(() => validateAppAudioPolicy({ recordAppAudio })).toThrow(/must be a boolean/);
		}
		for (const target of [{ url: "https://example.invalid" }, { command: { presentation: "native-terminal" } }, { application: { fixture: "textedit" } }]) {
			expect(() => validateAppAudioPolicy({ target, recordAppAudio: true })).toThrow(/non-fixture desktop/);
		}
		expect(() => validateAppAudioPolicy({ target: { application: { pid: 123 } }, recordAppAudio: true, recordWindowVideo: false })).toThrow(/requires window video/);
	});
	test("never infers recorded audio from a video file or missing helper evidence", () => {
		expect(appAudioEvidence("recording-started\n/tmp/window.mp4\n", true).status).toBe("unavailable");
		expect(appAudioEvidence("app-audio=recorded buffers=0\n", true).status).toBe("unavailable");
		expect(appAudioEvidence("app-audio=unavailable reason=no audio buffers captured\n", true)).toEqual({ status: "unavailable", reason: "no audio buffers captured" });
		expect(appAudioEvidence("app-audio=recorded buffers=25\n", true)).toEqual({ status: "recorded", scope: "selected-application", buffers: 25 });
		expect(appAudioEvidence("app-audio=recorded buffers=25\n", false)).toEqual({ status: "disabled" });
	});
});
