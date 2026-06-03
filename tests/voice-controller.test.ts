import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { APP_ICONS } from "../src/app/icons.js";
import { AppVoiceController, setVoiceControllerTestDeps, type AppVoiceControllerHost, type VoiceInputState } from "../src/app/input/voice-controller.js";
import type { DictationConfig } from "../src/config.js";

describe("AppVoiceController", () => {
	it("falls back to English or first configured language and hides the switcher for one language", () => {
		const oneLanguage = new AppVoiceController(fakeHost(), { languages: { de: { dirName: "de", url: "https://example.test/de.zip", label: "German" } } });
		const englishFallback = new AppVoiceController(fakeHost(), dictationConfig({ language: "missing" }));

		assert.equal(oneLanguage.showLanguageSwitcher(), false);
		assert.equal(oneLanguage.statusWidgetText(), APP_ICONS.microphone);
		assert.equal(englishFallback.statusWidgetText(), `${APP_ICONS.microphone} EN`);
	});

	it("formats every voice widget state and progress overlay", () => {
		const controller = new AppVoiceController(fakeHost(), dictationConfig({ language: "ru" }));
		const internals = controller as unknown as { state: VoiceInputState; progressMessage?: string; progressFrame: number };

		internals.state = "installing";
		assert.equal(controller.statusWidgetText(), `${APP_ICONS.microphone} RU ${APP_ICONS.timerSand}`);
		internals.state = "loading";
		assert.equal(controller.statusWidgetText(), `${APP_ICONS.microphone} RU ${APP_ICONS.timerSand}`);
		internals.state = "listening";
		assert.equal(controller.statusWidgetActive(), true);
		internals.progressMessage = "Downloading model";
		internals.progressFrame = 1000;
		assert.match(controller.progressOverlayText() ?? "", /Downloading model/u);
		internals.progressMessage = undefined;
		assert.equal(controller.progressOverlayText(), undefined);
	});

	it("cycles languages, saves selection errors as warnings, and restarts active recording", async () => {
		const host = fakeHost();
		const controller = new AppVoiceController(host, dictationConfig({ language: "en" }));
		const internals = controller as unknown as {
			state: VoiceInputState;
			startRecording(): Promise<void>;
			saveLanguageSelection(language: string): void;
			nextLanguage(): string;
		};
		let starts = 0;
		internals.startRecording = async () => { starts += 1; };
		internals.saveLanguageSelection = (language) => { host.toasts.push(`saved:${language}`); };
		internals.state = "listening";

		await controller.toggleLanguage();

		assert.equal(internals.nextLanguage(), "en");
		assert.equal(starts, 1);
		assert.ok(host.toasts.some((toast) => toast === "saved:ru"));
		assert.ok(host.toasts.some((toast) => toast.includes("Voice language: Russian")));
	});

	it("emits final and partial transcripts defensively", async () => {
		const host = fakeHost();
		const controller = new AppVoiceController(host, dictationConfig());
		const internals = controller as unknown as {
			emitTranscript(result: unknown): void;
			emitPartialTranscript(result: unknown): void;
			clearPartialTranscript(): void;
		};

		internals.emitTranscript('{"text":" hello   world "}');
		internals.emitTranscript({ text: " object  result " });
		internals.emitTranscript("not json");
		internals.emitPartialTranscript('{"partial":" partial   text "}');
		internals.emitPartialTranscript({ partial: "partial text" });
		await new Promise((resolve) => setTimeout(resolve, 130));
		internals.clearPartialTranscript();

		assert.deepEqual(host.transcripts, ["hello world", "object result"]);
		assert.deepEqual(host.partials, ["partial text", undefined]);
	});

	it("stops recording, frees cached models, and ignores duplicate progress messages", async () => {
		const host = fakeHost();
		const controller = new AppVoiceController(host, dictationConfig());
		const freed: string[] = [];
		const internals = controller as unknown as {
			state: VoiceInputState;
			audioProcess?: { killed: boolean; kill(signal: string): void };
			recognizer?: { finalResult(): unknown; free(): void };
			modelCache: Map<string, { free(): void }>;
			addProgressSystemMessage(message: string): void;
		};
		internals.state = "listening";
		internals.audioProcess = { killed: false, kill: (signal) => { freed.push(signal); } };
		internals.recognizer = { finalResult: () => ({ text: "final words" }), free: () => { freed.push("recognizer"); } };
		internals.modelCache.set("en", { free: () => { freed.push("model"); } });

		internals.addProgressSystemMessage("same");
		internals.addProgressSystemMessage("same");
		await controller.dispose();

		assert.deepEqual(host.systemMessages, ["Voice input: same"]);
		assert.deepEqual(host.transcripts, ["final words"]);
		assert.deepEqual(freed, ["SIGTERM", "recognizer", "model"]);
		assert.equal(controller.statusWidgetActive(), false);
	});

	it("binds recorder data and partial results without touching audio hardware", async () => {
		const host = fakeHost();
		const controller = new AppVoiceController(host, dictationConfig());
		const audioProcess = fakeAudioProcess();
		const recognizer = {
			acceptWaveform: (() => {
				let calls = 0;
				return (_buffer: Buffer) => {
					calls += 1;
					return calls > 1;
				};
			})(),
			partialResult: () => ({ partial: " partial draft " }),
			result: () => ({ text: "final transcript" }),
			finalResult: () => ({ text: "close transcript" }),
			free: () => { host.toasts.push("recognizer-freed"); },
		};
		const internals = controller as unknown as {
			state: VoiceInputState;
			audioProcess?: typeof audioProcess;
			recognizer?: typeof recognizer;
			startGeneration: number;
			bindAudioProcess(process: typeof audioProcess, recognizerArg: typeof recognizer, generation: number): void;
		};
		internals.state = "listening";
		internals.audioProcess = audioProcess;
		internals.recognizer = recognizer;
		internals.startGeneration = 1;
		internals.bindAudioProcess(audioProcess, recognizer, 1);

		audioProcess.stdout.emit("data", Buffer.from("pcm-1"));
		await new Promise((resolve) => setTimeout(resolve, 130));
		audioProcess.stdout.emit("data", Buffer.from("pcm-2"));

		assert.deepEqual(host.partials, ["partial draft", undefined]);
		assert.deepEqual(host.transcripts, ["final transcript"]);

	});

	it("reports recorder errors by surfacing a toast and stopping the current session", () => {
		const host = fakeHost();
		const controller = new AppVoiceController(host, dictationConfig());
		const audioProcess = fakeAudioProcess();
		const recognizer = {
			acceptWaveform: () => { throw new Error("decoder boom"); },
			result: () => ({ text: "ignored" }),
			finalResult: () => ({ text: "ignored" }),
		};
		let stopCalls = 0;
		const internals = controller as unknown as {
			state: VoiceInputState;
			audioProcess?: typeof audioProcess;
			recognizer?: typeof recognizer;
			startGeneration: number;
			bindAudioProcess(process: typeof audioProcess, recognizerArg: typeof recognizer, generation: number): void;
			stopRecording(): Promise<void>;
		};
		internals.state = "listening";
		internals.audioProcess = audioProcess;
		internals.recognizer = recognizer;
		internals.startGeneration = 1;
		internals.stopRecording = async () => { stopCalls += 1; };
		internals.bindAudioProcess(audioProcess, recognizer, 1);

		audioProcess.stdout.emit("data", Buffer.from("pcm"));

		assert.equal(stopCalls, 1);
		assert.ok(host.toasts.some((toast) => toast.includes("Voice recognition failed: decoder boom")));
	});

	it("handles recorder process errors by clearing the active recognizer and returning to idle", () => {
		const host = fakeHost();
		const controller = new AppVoiceController(host, dictationConfig());
		const audioProcess = fakeAudioProcess();
		const recognizer = {
			acceptWaveform: () => false,
			finalResult: () => ({ text: "final" }),
			free: () => { host.toasts.push("recognizer-freed"); },
		};
		const internals = controller as unknown as {
			state: VoiceInputState;
			audioProcess?: typeof audioProcess;
			recognizer?: typeof recognizer;
			startGeneration: number;
			bindAudioProcess(process: typeof audioProcess, recognizerArg: typeof recognizer, generation: number): void;
		};
		internals.state = "listening";
		internals.audioProcess = audioProcess;
		internals.recognizer = recognizer;
		internals.startGeneration = 1;
		internals.bindAudioProcess(audioProcess, recognizer, 1);

		audioProcess.emit("error", new Error("device lost"));

		assert.equal(internals.state, "idle");
		assert.equal(internals.audioProcess, undefined);
		assert.equal(internals.recognizer, undefined);
		assert.ok(host.toasts.some((toast) => toast.includes("Voice recorder failed: device lost")));
	});

	it("toggles recording by delegating to the matching start or stop path", async () => {
		const controller = new AppVoiceController(fakeHost(), dictationConfig());
		const internals = controller as unknown as {
			state: VoiceInputState;
			startRecording(): Promise<void>;
			stopRecording(): Promise<void>;
		};
		let starts = 0;
		let stops = 0;
		internals.startRecording = async () => { starts += 1; };
		internals.stopRecording = async () => { stops += 1; };

		internals.state = "idle";
		await controller.toggleRecording();
		internals.state = "listening";
		await controller.toggleRecording();

		assert.equal(starts, 1);
		assert.equal(stops, 1);
	});

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

	it("starts recording with mocked Vosk, model, recorder, and spawn dependencies", async () => {
		const host = fakeHost();
		const audioProcess = fakeAudioProcess();
		const modelPaths: string[] = [];
		const spawned: Array<{ command: string; args: string[] }> = [];
		const freed: string[] = [];
		const controller = new AppVoiceController(host, dictationConfig({ language: "en" }));
		const vosk = {
			setLogLevel: (level: number) => { host.toasts.push(`log:${level}`); },
			Model: class {
				constructor(modelPath: string) { modelPaths.push(modelPath); }
				free(): void { freed.push("model"); }
			},
			Recognizer: class {
				acceptWaveform(): boolean { return true; }
				result(): unknown { return { text: "started transcript" }; }
				finalResult(): unknown { return { text: "closed transcript" }; }
				free(): void { freed.push("recognizer"); }
			},
		};

		setVoiceControllerTestDeps({
			tryLoadVosk: () => ({ ok: true, module: vosk }) as never,
			ensureModel: async (language, definition) => {
				assert.equal(language, "en");
				assert.equal(definition.label, "English");
				return "/mock/en-model";
			},
			selectRecorderCommand: async () => ({ command: "rec", args: ["--mock"], description: "mock recorder" }),
			spawn: ((command: string, args: string[]) => {
				spawned.push({ command, args });
				return audioProcess;
			}) as never,
		});
		try {
			await controller.toggleRecording();

			assert.equal(controller.statusWidgetActive(), true);
			assert.deepEqual(modelPaths, ["/mock/en-model"]);
			assert.deepEqual(spawned, [{ command: "rec", args: ["--mock"] }]);
			assert.ok(host.toasts.includes("log:-1"));
			assert.ok(host.toasts.some((toast) => toast.includes("Voice input on (English, mock recorder)")));

			audioProcess.stdout.emit("data", Buffer.from("pcm"));
			audioProcess.emit("close", 0, null);

			assert.deepEqual(host.transcripts, ["started transcript", "closed transcript"]);
			assert.deepEqual(freed, ["recognizer"]);
			assert.equal(controller.statusWidgetActive(), false);
		} finally {
			setVoiceControllerTestDeps();
		}
	});

	it("surfaces mocked start-recording failures without touching audio hardware", async () => {
		const host = fakeHost();
		const controller = new AppVoiceController(host, dictationConfig());

		setVoiceControllerTestDeps({
			tryLoadVosk: () => ({ ok: true, module: {
				Model: class {},
				Recognizer: class {},
			} }) as never,
			ensureModel: async () => { throw new Error("model unavailable"); },
			spawn: (() => { throw new Error("spawn should not run"); }) as never,
		});
		try {
			await controller.toggleRecording();

			assert.equal(controller.statusWidgetActive(), false);
			assert.ok(host.systemMessages.some((message) => message.includes("Voice input: Unavailable: model unavailable")));
			assert.ok(host.toasts.some((toast) => toast.includes("Voice input unavailable: model unavailable")));
		} finally {
			setVoiceControllerTestDeps();
		}
	});
});


function fakeAudioProcess(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill(signal: string): void } {
	const audioProcess = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill(signal: string): void };
	audioProcess.stdout = new EventEmitter();
	audioProcess.stderr = new EventEmitter();
	audioProcess.killed = false;
	audioProcess.kill = function kill(_signal: string): void {
		this.killed = true;
	};
	return audioProcess;
}

function dictationConfig(overrides: { language?: string } = {}): DictationConfig {
	return {
		...overrides,
		languages: {
			en: { dirName: "en-model", url: "https://example.test/en.zip", label: "English" },
			ru: { dirName: "ru-model", url: "https://example.test/ru.zip", label: "Russian" },
		},
	};
}

function fakeHost(): AppVoiceControllerHost & { transcripts: string[]; partials: Array<string | undefined>; systemMessages: string[]; toasts: string[] } {
	const transcripts: string[] = [];
	const partials: Array<string | undefined> = [];
	const systemMessages: string[] = [];
	const toasts: string[] = [];
	return {
		transcripts,
		partials,
		systemMessages,
		toasts,
		insertTranscript: (text) => { transcripts.push(text); },
		setPartialTranscript: (text) => { partials.push(text); },
		addSystemMessage: (message) => { systemMessages.push(message); },
		showToast: (message, kind) => { toasts.push(`${kind}:${message}`); },
		requestRender: () => {},
	};
}
