import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_ICONS } from "../src/app/icons.js";
import { AppVoiceController, type AppVoiceControllerHost, type VoiceInputState } from "../src/app/voice-controller.js";
import type { DictationConfig } from "../src/config.js";

describe("AppVoiceController", () => {
	it("uses the download icon in place of the microphone while downloading a model", () => {
		const controller = new AppVoiceController(fakeHost(), dictationConfig({ language: "ru" }));
		(controller as unknown as { state: VoiceInputState }).state = "downloading";

		assert.equal(controller.statusWidgetText(), `${APP_ICONS.down} RU`);
		assert.ok(!controller.statusWidgetText().includes(APP_ICONS.microphone));
	});

	it("initializes from the saved dictation language when it is enabled", () => {
		const controller = new AppVoiceController(fakeHost(), dictationConfig({ language: "ru" }));

		assert.equal(controller.statusWidgetText(), `${APP_ICONS.microphone} RU`);
	});
});

function dictationConfig(overrides: { language?: string } = {}): DictationConfig {
	return {
		...overrides,
		languages: {
			en: { dirName: "en-model", url: "https://example.test/en.zip", label: "English" },
			ru: { dirName: "ru-model", url: "https://example.test/ru.zip", label: "Russian" },
		},
	};
}

function fakeHost(): AppVoiceControllerHost {
	return {
		insertTranscript: () => {},
		setPartialTranscript: () => {},
		addSystemMessage: () => {},
		showToast: () => {},
		render: () => {},
	};
}
