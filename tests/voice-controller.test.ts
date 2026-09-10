import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { APP_ICONS } from "../src/app/icons.js";
import {
	AppVoiceController,
	buildDeepgramUrl,
	parseDeepgramTranscript,
	setVoiceControllerTestDeps,
	type AppVoiceControllerHost,
	type VoiceInputState,
} from "../src/app/input/voice-controller.js";
import type { DictationConfig } from "../src/config.js";

describe("AppVoiceController", () => {
	it("falls back to English or the first configured language and hides a single-language switcher", () => {
		const oneLanguage = new AppVoiceController(fakeHost(), { languages: { de: { label: "German", deepgramLanguage: "de" } } });
		const englishFallback = new AppVoiceController(fakeHost(), dictationConfig({ language: "missing" }));

		assert.equal(oneLanguage.showLanguageSwitcher(), false);
		assert.equal(oneLanguage.statusWidgetText(), APP_ICONS.microphone);
		assert.equal(englishFallback.statusWidgetText(), `${APP_ICONS.microphone} EN`);
	});

	it("formats connecting/listening status and progress", () => {
		const controller = new AppVoiceController(fakeHost(), dictationConfig({ language: "ru" }));
		const internals = controller as unknown as { state: VoiceInputState; progressMessage?: string; progressFrame: number };

		internals.state = "connecting";
		assert.equal(controller.statusWidgetText(), `${APP_ICONS.microphone} RU ${APP_ICONS.timerSand}`);
		internals.progressMessage = "Connecting to Deepgram";
		internals.progressFrame = 1000;
		assert.match(controller.progressOverlayText() ?? "", /Connecting to Deepgram/u);
		internals.state = "listening";
		assert.equal(controller.statusWidgetActive(), true);
		assert.equal(controller.statusWidgetText(), `${APP_ICONS.microphone} RU`);
	});

	it("cycles languages, saves the choice, and restarts active recording", async () => {
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
		assert.ok(host.toasts.includes("saved:ru"));
		assert.ok(host.toasts.some((toast) => toast.includes("Voice language: Russian")));
	});

	it("builds the Deepgram live URL for raw 16 kHz mono PCM", () => {
		const url = new URL(buildDeepgramUrl("nova-3", "ru", true));

		assert.equal(url.origin, "wss://api.deepgram.com");
		assert.equal(url.pathname, "/v1/listen");
		assert.equal(url.searchParams.get("model"), "nova-3");
		assert.equal(url.searchParams.get("language"), "ru");
		assert.equal(url.searchParams.get("encoding"), "linear16");
		assert.equal(url.searchParams.get("sample_rate"), "16000");
		assert.equal(url.searchParams.get("channels"), "1");
		assert.equal(url.searchParams.get("interim_results"), "true");
	});

	it("parses Deepgram final and interim Results defensively", () => {
		assert.deepEqual(parseDeepgramTranscript(JSON.stringify({
			type: "Results",
			is_final: false,
			channel: { alternatives: [{ transcript: " partial   words " }] },
		})), { text: "partial words", isFinal: false });
		assert.deepEqual(parseDeepgramTranscript(Buffer.from(JSON.stringify({
			type: "Results",
			is_final: true,
			channel: { alternatives: [{ transcript: " final words " }] },
		}))), { text: "final words", isFinal: true });
		assert.equal(parseDeepgramTranscript("not json"), undefined);
		assert.equal(parseDeepgramTranscript(JSON.stringify({ type: "Metadata" })), undefined);
		assert.equal(parseDeepgramTranscript(JSON.stringify({
			type: "Results",
			channel: { alternatives: [{ transcript: "   " }] },
		})), undefined);
	});

	it("streams recorder PCM, emits interim/final text, finalizes, and commits the last interim on stop", async () => {
		const host = fakeHost();
		const audioProcess = fakeAudioProcess();
		const socket = new FakeSocket();
		const sockets: Array<{ url: string; protocols: string[] }> = [];
		const spawned: Array<{ command: string; args: string[] }> = [];
		const controller = new AppVoiceController(host, dictationConfig({
			language: "ru",
			model: "nova-3",
			apiKey: "dg-config-key",
		}));

		setVoiceControllerTestDeps({
			deepgramApiKey: () => "dg-env-fallback-key",
			selectRecorderCommand: async () => ({ command: "rec", args: ["--mock"], description: "mock recorder" }),
			createDeepgramSocket: ((url: string, protocols: string[]) => {
				sockets.push({ url, protocols });
				return socket;
			}) as never,
			waitForSocketOpen: async () => {},
			spawn: ((command: string, args: string[]) => {
				spawned.push({ command, args });
				return audioProcess;
			}) as never,
			delay: async () => {},
		});
		try {
			await controller.toggleRecording();

			assert.equal(controller.statusWidgetActive(), true);
			assert.deepEqual(spawned, [{ command: "rec", args: ["--mock"] }]);
			assert.deepEqual(sockets[0]?.protocols, ["token", "dg-config-key"]);
			const socketUrl = new URL(sockets[0]?.url ?? "");
			assert.equal(socketUrl.searchParams.get("language"), "ru");
			assert.equal(socketUrl.searchParams.get("model"), "nova-3");

			audioProcess.stdout.emit("data", Buffer.from("pcm"));
			assert.ok(Buffer.isBuffer(socket.sent[0]));
			socket.emitMessage(deepgramResult("interim draft", false));
			await new Promise((resolve) => setTimeout(resolve, 130));
			assert.deepEqual(host.partials, ["interim draft"]);

			socket.emitMessage(deepgramResult("final transcript", true));
			assert.deepEqual(host.partials, ["interim draft", undefined]);
			assert.deepEqual(host.transcripts, ["final transcript"]);

			socket.emitMessage(deepgramResult("tail words", false));
			await controller.stopRecording();

			assert.equal(audioProcess.killed, true);
			assert.ok(socket.sent.some((value) => value === JSON.stringify({ type: "Finalize" })));
			assert.deepEqual(host.transcripts, ["final transcript", "tail words"]);
			assert.equal(socket.closed, true);
			assert.equal(controller.statusWidgetActive(), false);
		} finally {
			setVoiceControllerTestDeps();
		}
	});

	it("surfaces a missing Deepgram key without touching audio hardware", async () => {
		const host = fakeHost();
		const controller = new AppVoiceController(host, dictationConfig());
		let recorderSelections = 0;

		setVoiceControllerTestDeps({
			deepgramApiKey: () => undefined,
			selectRecorderCommand: async () => {
				recorderSelections += 1;
				return { command: "rec", args: [], description: "mock" };
			},
		});
		try {
			await controller.toggleRecording();

			assert.equal(recorderSelections, 0);
			assert.equal(controller.statusWidgetActive(), false);
			assert.ok(host.systemMessages.some((message) => message.includes("set dictation.apiKey in ~/.config/pi/pix.jsonc or DEEPGRAM_API_KEY")));
			assert.ok(host.toasts.some((toast) => toast.includes("set dictation.apiKey in ~/.config/pi/pix.jsonc or DEEPGRAM_API_KEY")));
		} finally {
			setVoiceControllerTestDeps();
		}
	});

	it("reports recorder send errors and stops the active session", async () => {
		const host = fakeHost();
		const audioProcess = fakeAudioProcess();
		const socket = new FakeSocket();
		socket.sendError = new Error("socket send boom");
		const controller = new AppVoiceController(host, dictationConfig());

		setVoiceControllerTestDeps({
			deepgramApiKey: () => "dg-test-key",
			selectRecorderCommand: async () => ({ command: "rec", args: [], description: "mock" }),
			createDeepgramSocket: (() => socket) as never,
			waitForSocketOpen: async () => {},
			spawn: (() => audioProcess) as never,
			delay: async () => {},
		});
		try {
			await controller.toggleRecording();
			audioProcess.stdout.emit("data", Buffer.from("pcm"));
			await Promise.resolve();

			assert.ok(host.toasts.some((toast) => toast.includes("Voice recognition failed: socket send boom")));
			await controller.stopRecording();
			assert.equal(controller.statusWidgetActive(), false);
		} finally {
			setVoiceControllerTestDeps();
		}
	});

	it("discards an async Deepgram start after the originating tab changes", async () => {
		const host = fakeHost();
		host.activeScope.value = "tab-a";
		const controller = new AppVoiceController(host, dictationConfig());
		let resolveRecorder!: (recorder: { command: string; args: string[]; description: string }) => void;
		let sockets = 0;

		setVoiceControllerTestDeps({
			deepgramApiKey: () => "dg-test-key",
			selectRecorderCommand: async () => await new Promise((resolve) => { resolveRecorder = resolve; }),
			createDeepgramSocket: (() => {
				sockets += 1;
				return new FakeSocket();
			}) as never,
		});
		try {
			const starting = controller.toggleRecording();
			await Promise.resolve();
			host.activeScope.value = "tab-b";
			resolveRecorder({ command: "rec", args: [], description: "mock" });
			await starting;

			assert.equal(sockets, 0);
			assert.equal(controller.statusWidgetActive(), false);
			assert.deepEqual(host.transcripts, []);
			assert.deepEqual(host.partials, []);
		} finally {
			setVoiceControllerTestDeps();
		}
	});

	it("does not emit a pending interim or final result into a newer tab", async () => {
		const host = fakeHost();
		host.activeScope.value = "tab-a";
		const audioProcess = fakeAudioProcess();
		const socket = new FakeSocket();
		const controller = new AppVoiceController(host, dictationConfig());

		setVoiceControllerTestDeps({
			deepgramApiKey: () => "dg-test-key",
			selectRecorderCommand: async () => ({ command: "rec", args: [], description: "mock" }),
			createDeepgramSocket: (() => socket) as never,
			waitForSocketOpen: async () => {},
			spawn: (() => audioProcess) as never,
			delay: async () => {},
		});
		try {
			await controller.toggleRecording();
			socket.emitMessage(deepgramResult("old tab partial", false));
			host.activeScope.value = "tab-b";
			await controller.stopRecording();
			socket.emitMessage(deepgramResult("old tab final", true));
			await new Promise((resolve) => setTimeout(resolve, 130));

			assert.deepEqual(host.transcripts, []);
			assert.deepEqual(host.partials, []);
		} finally {
			setVoiceControllerTestDeps();
		}
	});

	it("deduplicates progress system messages", () => {
		const host = fakeHost();
		const controller = new AppVoiceController(host, dictationConfig());
		const internals = controller as unknown as { addProgressSystemMessage(message: string): void };

		internals.addProgressSystemMessage("same");
		internals.addProgressSystemMessage("same");

		assert.deepEqual(host.systemMessages, ["Voice input: same"]);
	});

	it("does not restart recording when toggle is pressed while a stop is already in progress", async () => {
		const controller = new AppVoiceController(fakeHost(), dictationConfig());
		let releaseStop!: () => void;
		const internals = controller as unknown as {
			state: VoiceInputState;
			stopPromise?: Promise<void>;
			startRecording(): Promise<void>;
		};
		let starts = 0;
		internals.state = "idle";
		internals.startRecording = async () => { starts += 1; };
		internals.stopPromise = new Promise<void>((resolve) => { releaseStop = resolve; });

		const toggling = controller.toggleRecording();
		releaseStop();
		await toggling;

		assert.equal(starts, 0);
	});

	it("does not restart recording when language changes during an already-running stop", async () => {
		const host = fakeHost();
		const controller = new AppVoiceController(host, dictationConfig({ language: "en" }));
		let releaseStop!: () => void;
		const internals = controller as unknown as {
			state: VoiceInputState;
			stopPromise?: Promise<void>;
			startRecording(): Promise<void>;
		};
		let starts = 0;
		internals.state = "idle";
		internals.startRecording = async () => { starts += 1; };
		internals.stopPromise = new Promise<void>((resolve) => { releaseStop = resolve; });

		const switching = controller.toggleLanguage();
		releaseStop();
		await switching;

		assert.equal(starts, 0);
		assert.equal(controller.statusWidgetText(), `${APP_ICONS.microphone} EN`);
	});

	it("does not restart voice after dispose while a language transition is waiting on stop", async () => {
		const host = fakeHost();
		const controller = new AppVoiceController(host, dictationConfig({ language: "en" }));
		let releaseStop!: () => void;
		const internals = controller as unknown as {
			state: VoiceInputState;
			stopPromise?: Promise<void>;
			startRecording(): Promise<void>;
		};
		let starts = 0;
		internals.state = "idle";
		internals.startRecording = async () => { starts += 1; };
		internals.stopPromise = new Promise<void>((resolve) => { releaseStop = resolve; });

		const switching = controller.toggleLanguage();
		await controller.dispose();
		releaseStop();
		await switching;

		assert.equal(starts, 0);
		assert.equal(controller.statusWidgetText(), `${APP_ICONS.microphone} EN`);
	});

	it("waits for recorder close so buffered PCM after SIGTERM is sent before Finalize", async () => {
		const host = fakeHost();
		const audioProcess = fakeAudioProcess();
		const socket = new FakeSocket();
		const controller = new AppVoiceController(host, dictationConfig());
		audioProcess.kill = function kill(_signal: string): boolean {
			this.killed = true;
			setTimeout(() => {
				this.stdout.emit("data", Buffer.from("tail-pcm"));
				this.exitCode = 0;
				this.emit("close", 0, null);
			}, 80);
			return true;
		};

		setVoiceControllerTestDeps({
			deepgramApiKey: () => "dg-test-key",
			selectRecorderCommand: async () => ({ command: "rec", args: [], description: "mock" }),
			createDeepgramSocket: (() => socket) as never,
			waitForSocketOpen: async () => {},
			spawn: (() => audioProcess) as never,
		});
		try {
			await controller.toggleRecording();
			await controller.stopRecording();

			const tailIndex = socket.sent.findIndex((value) => Buffer.isBuffer(value) && value.toString("utf8") === "tail-pcm");
			const finalizeIndex = socket.sent.findIndex((value) => value === JSON.stringify({ type: "Finalize" }));
			assert.ok(tailIndex >= 0);
			assert.ok(finalizeIndex > tailIndex);
		} finally {
			setVoiceControllerTestDeps();
		}
	});

	it("dispose does not wait for Deepgram finalization during application shutdown", async () => {
		const host = fakeHost();
		const audioProcess = fakeAudioProcess();
		const socket = new FakeSocket();
		const controller = new AppVoiceController(host, dictationConfig());
		const signals: string[] = [];
		audioProcess.kill = function kill(signal: string): boolean {
			signals.push(signal);
			this.killed = true;
			return true;
		};

		setVoiceControllerTestDeps({
			deepgramApiKey: () => "dg-test-key",
			selectRecorderCommand: async () => ({ command: "rec", args: [], description: "mock" }),
			createDeepgramSocket: (() => socket) as never,
			waitForSocketOpen: async () => {},
			spawn: (() => audioProcess) as never,
			delay: async () => await new Promise<void>(() => {}),
		});
		try {
			await controller.toggleRecording();
			const result = await Promise.race([
				controller.dispose().then(() => "disposed" as const),
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 40)),
			]);

			assert.equal(result, "disposed");
			assert.ok(signals.includes("SIGKILL"));
			assert.equal(socket.closed, true);
		} finally {
			setVoiceControllerTestDeps();
		}
	});
});

class FakeSocket {
	readyState = 1;
	closed = false;
	sent: unknown[] = [];
	sendError: Error | undefined;
	private readonly listeners = new Map<string, Set<(event: { data?: unknown; code?: number; reason?: string }) => void>>();

	send(data: unknown): void {
		if (this.sendError) throw this.sendError;
		this.sent.push(data);
	}

	close(_code?: number, _reason?: string): void {
		this.closed = true;
		this.readyState = 3;
	}

	addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	emitMessage(data: string): void {
		this.emit("message", { data });
	}

	private emit(type: string, event: { data?: unknown; code?: number; reason?: string }): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

function fakeAudioProcess(): EventEmitter & {
	stdout: EventEmitter;
	stderr: EventEmitter;
	killed: boolean;
	exitCode: number | null;
	kill(signal: string): boolean;
} {
	const audioProcess = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		killed: boolean;
		exitCode: number | null;
		kill(signal: string): boolean;
	};
	audioProcess.stdout = new EventEmitter();
	audioProcess.stderr = new EventEmitter();
	audioProcess.killed = false;
	audioProcess.exitCode = null;
	audioProcess.kill = function kill(_signal: string): boolean {
		this.killed = true;
		return true;
	};
	return audioProcess;
}

function deepgramResult(text: string, isFinal: boolean): string {
	return JSON.stringify({
		type: "Results",
		is_final: isFinal,
		channel: { alternatives: [{ transcript: text }] },
	});
}

function dictationConfig(overrides: { language?: string; model?: string; apiKey?: string } = {}): DictationConfig {
	return {
		...overrides,
		languages: {
			en: { deepgramLanguage: "en", label: "English" },
			ru: { deepgramLanguage: "ru", label: "Russian" },
		},
	};
}

function fakeHost(): AppVoiceControllerHost & {
	transcripts: string[];
	partials: Array<string | undefined>;
	systemMessages: string[];
	toasts: string[];
	activeScope: { value: string | undefined };
} {
	const transcripts: string[] = [];
	const partials: Array<string | undefined> = [];
	const systemMessages: string[] = [];
	const toasts: string[] = [];
	const activeScope = { value: undefined as string | undefined };
	return {
		transcripts,
		partials,
		systemMessages,
		toasts,
		activeScope,
		activeInputScope: () => activeScope.value,
		insertTranscript: (text) => { transcripts.push(text); },
		setPartialTranscript: (text) => { partials.push(text); },
		addSystemMessage: (message) => { systemMessages.push(message); },
		showToast: (message, kind) => { toasts.push(`${kind}:${message}`); },
		render: () => {},
	};
}
