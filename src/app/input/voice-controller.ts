import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import {
	savePixDictationLanguage,
	type DictationConfig,
	type DictationLanguageModelConfig,
} from "../../config.js";
import { APP_ICONS } from "../icons.js";
import { commandExists } from "../process.js";

export type VoiceLanguage = string;
export type VoiceInputState = "idle" | "connecting" | "listening";

export type AppVoiceControllerHost = {
	activeInputScope(): string | undefined;
	insertTranscript(text: string): void;
	setPartialTranscript(text: string | undefined): void;
	addSystemMessage(message: string): void;
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	render(): void;
};

type VoiceLanguageDefinition = DictationLanguageModelConfig;

type RecorderCommand = {
	command: string;
	args: string[];
	description: string;
};

type DeepgramSocketEvent = {
	data?: unknown;
	code?: number;
	reason?: string;
};

type DeepgramSocketListener = (event: DeepgramSocketEvent) => void;

type DeepgramSocket = {
	readyState: number;
	send(data: unknown): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: DeepgramSocketListener): void;
	removeEventListener(type: string, listener: DeepgramSocketListener): void;
};

export type DeepgramTranscript = {
	text: string;
	isFinal: boolean;
};

const SAMPLE_RATE = 16_000;
const DEEPGRAM_SOCKET_OPEN = 1;
const DEEPGRAM_SOCKET_CONNECT_TIMEOUT_MS = 10_000;
const RECORDER_STOP_GRACE_MS = 150;
const RECORDER_FORCE_STOP_GRACE_MS = 50;
const DEEPGRAM_FINALIZE_GRACE_MS = 300;
const DEFAULT_DEEPGRAM_MODEL = "nova-3";
const VOICE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const VOICE_PARTIAL_TRANSCRIPT_THROTTLE_MS = 100;

type VoiceControllerTestDeps = {
	deepgramApiKey: () => string | undefined;
	createDeepgramSocket: typeof createDeepgramSocket;
	waitForSocketOpen: typeof waitForSocketOpen;
	selectRecorderCommand: typeof selectRecorderCommand;
	spawn: typeof spawn;
	savePixDictationLanguage: typeof savePixDictationLanguage;
	delay: typeof delay;
};

const defaultVoiceControllerDeps: VoiceControllerTestDeps = {
	deepgramApiKey: () => process.env.DEEPGRAM_API_KEY?.trim() || undefined,
	createDeepgramSocket,
	waitForSocketOpen,
	selectRecorderCommand,
	spawn,
	savePixDictationLanguage,
	delay,
};

let voiceControllerDeps = defaultVoiceControllerDeps;

export function setVoiceControllerTestDeps(overrides?: Partial<VoiceControllerTestDeps>): void {
	voiceControllerDeps = overrides ? { ...defaultVoiceControllerDeps, ...overrides } : defaultVoiceControllerDeps;
}

export class AppVoiceController {
	private languageDefinitions: Record<VoiceLanguage, VoiceLanguageDefinition>;
	private languages: VoiceLanguage[];
	private language: VoiceLanguage;
	private deepgramModel: string;
	private state: VoiceInputState = "idle";
	private audioProcess: ChildProcessByStdio<null, Readable, Readable> | undefined;
	private socket: DeepgramSocket | undefined;
	private progressMessage: string | undefined;
	private progressFrame = 0;
	private progressTimer: ReturnType<typeof setInterval> | undefined;
	private lastSystemProgressMessage: string | undefined;
	private partialTranscript: string | undefined;
	private partialTranscriptTimer: ReturnType<typeof setTimeout> | undefined;
	private startGeneration = 0;
	private recordingScope: string | undefined;
	private stopPromise: Promise<void> | undefined;
	private disposed = false;

	constructor(private readonly host: AppVoiceControllerHost, dictationConfig: DictationConfig) {
		this.languageDefinitions = dictationConfig.languages;
		this.languages = Object.keys(this.languageDefinitions);
		this.language = this.initialLanguage(dictationConfig.language);
		this.deepgramModel = dictationConfig.model?.trim() || DEFAULT_DEEPGRAM_MODEL;
	}

	updateDictationConfig(dictationConfig: DictationConfig): void {
		this.languageDefinitions = dictationConfig.languages;
		this.languages = Object.keys(this.languageDefinitions);
		this.language = this.initialLanguage(dictationConfig.language ?? this.language);
		this.deepgramModel = dictationConfig.model?.trim() || DEFAULT_DEEPGRAM_MODEL;
	}

	statusWidgetText(): string {
		const languageLabel = this.showLanguageSwitcher() ? ` ${this.language.toUpperCase()}` : "";
		return this.state === "connecting"
			? `${APP_ICONS.microphone}${languageLabel} ${APP_ICONS.timerSand}`
			: `${APP_ICONS.microphone}${languageLabel}`;
	}

	showLanguageSwitcher(): boolean {
		return this.languages.length > 1;
	}

	statusWidgetActive(): boolean {
		return this.state === "listening";
	}

	progressOverlayText(): string | undefined {
		if (!this.progressMessage) return undefined;
		const spinner = VOICE_SPINNER_FRAMES[this.progressFrame % VOICE_SPINNER_FRAMES.length] ?? APP_ICONS.timerSand;
		return `${spinner} ${this.progressMessage}`;
	}

	async toggleRecording(): Promise<void> {
		if (this.disposed) return;
		if (this.stopPromise) {
			await this.stopPromise;
			return;
		}
		if (this.state !== "idle") {
			await this.stopRecording();
			return;
		}
		await this.startRecording();
	}

	async toggleLanguage(): Promise<void> {
		if (this.disposed || !this.showLanguageSwitcher()) return;
		if (this.stopPromise) {
			await this.stopPromise;
			return;
		}

		const scope = this.host.activeInputScope();
		const shouldRestart = this.state !== "idle";
		if (shouldRestart) await this.stopRecording();
		if (this.disposed || !this.isScopeActive(scope)) return;

		this.language = this.nextLanguage();
		this.saveLanguageSelection(this.language);
		this.host.showToast(`Voice language: ${this.languageDefinition(this.language).label}`, "info");
		this.host.render();

		if (shouldRestart) void this.startRecording();
	}

	async stopRecording(): Promise<void> {
		if (this.disposed) return;
		if (this.stopPromise) return await this.stopPromise;
		const stopping = Promise.resolve().then(() => this.stopRecordingNow());
		this.stopPromise = stopping;
		try {
			await stopping;
		} finally {
			if (this.stopPromise === stopping) this.stopPromise = undefined;
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.startGeneration += 1;
		const audioProcess = this.audioProcess;
		const socket = this.socket;
		this.audioProcess = undefined;
		this.socket = undefined;
		this.recordingScope = undefined;
		this.clearProgressMessage();
		this.partialTranscript = undefined;
		if (this.partialTranscriptTimer) {
			clearTimeout(this.partialTranscriptTimer);
			this.partialTranscriptTimer = undefined;
		}
		this.state = "idle";
		if (audioProcess?.exitCode === null) safeKillProcess(audioProcess, "SIGKILL");
		if (socket) safeCloseSocket(socket);
	}

	private async startRecording(): Promise<void> {
		if (this.disposed) return;
		const language = this.language;
		const scope = this.host.activeInputScope();
		const generation = this.startGeneration + 1;
		this.startGeneration = generation;
		this.recordingScope = scope;
		this.state = "connecting";
		this.setProgressMessage("Connecting to Deepgram...", generation, scope);

		let socket: DeepgramSocket | undefined;
		try {
			const apiKey = voiceControllerDeps.deepgramApiKey();
			if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not set");

			const recorder = await voiceControllerDeps.selectRecorderCommand();
			if (!this.continueStart(generation, scope)) return;

			socket = voiceControllerDeps.createDeepgramSocket(
				buildDeepgramUrl(this.deepgramModel, this.deepgramLanguage(language), true),
				["token", apiKey],
			);
			this.socket = socket;
			await voiceControllerDeps.waitForSocketOpen(socket);
			if (!this.continueStart(generation, scope) || this.socket !== socket) {
				safeCloseSocket(socket);
				return;
			}

			this.bindSocket(socket, generation, scope);
			const audioProcess = voiceControllerDeps.spawn(recorder.command, recorder.args, { stdio: ["ignore", "pipe", "pipe"] });
			this.audioProcess = audioProcess;
			this.clearProgressMessage();
			this.state = "listening";
			this.host.render();
			this.host.showToast(`Voice input on (${this.languageDefinition(language).label}, Deepgram ${this.deepgramModel})`, "info");
			this.bindAudioProcess(audioProcess, socket, generation, scope);
		} catch (error) {
			if (!this.isCurrentStart(generation, scope)) {
				if (socket) safeCloseSocket(socket);
				return;
			}
			this.startGeneration += 1;
			this.recordingScope = undefined;
			this.audioProcess = undefined;
			this.socket = undefined;
			if (socket) safeCloseSocket(socket);
			this.clearPartialTranscript(scope);
			this.clearProgressMessage();
			this.state = "idle";
			this.addProgressSystemMessage(`Unavailable: ${errorMessage(error)}`);
			this.host.showToast(`Voice input unavailable: ${errorMessage(error)}`, "error");
			this.host.render();
		}
	}

	private async stopRecordingNow(): Promise<void> {
		const scope = this.recordingScope;
		const generation = this.startGeneration;
		const audioProcess = this.audioProcess;
		const socket = this.socket;
		const wasListening = this.state === "listening";

		this.clearProgressMessage();
		this.state = "idle";
		if (this.isScopeActive(scope)) this.host.render();

		if (!wasListening || !socket || socket.readyState !== DEEPGRAM_SOCKET_OPEN) {
			if (audioProcess?.exitCode === null) safeKillProcess(audioProcess, "SIGKILL");
			if (this.audioProcess === audioProcess) this.audioProcess = undefined;
			this.startGeneration += 1;
			this.socket = undefined;
			this.recordingScope = undefined;
			this.clearPartialTranscript(scope);
			if (socket) safeCloseSocket(socket);
			return;
		}

		if (audioProcess) await stopRecorderProcess(audioProcess);
		if (this.audioProcess === audioProcess) this.audioProcess = undefined;

		try {
			socket.send(JSON.stringify({ type: "Finalize" }));
		} catch {
			// Closing below still commits the most recent interim result.
		}
		await voiceControllerDeps.delay(DEEPGRAM_FINALIZE_GRACE_MS);

		if (this.startGeneration === generation && this.recordingScope === scope && this.socket === socket) {
			this.commitPartialTranscript(scope);
			this.startGeneration += 1;
			this.socket = undefined;
			this.recordingScope = undefined;
		}
		safeCloseSocket(socket);
	}

	private bindSocket(socket: DeepgramSocket, generation: number, scope: string | undefined): void {
		socket.addEventListener("message", (event) => {
			if (!this.isCurrentSocket(socket, generation, scope)) return;
			const transcript = parseDeepgramTranscript(event.data);
			if (!transcript) return;
			if (transcript.isFinal) {
				this.clearPartialTranscript(scope);
				this.host.insertTranscript(transcript.text);
				return;
			}
			this.emitPartialTranscript(transcript.text, socket, generation, scope);
		});

		socket.addEventListener("error", () => {
			if (!this.isCurrentSocket(socket, generation, scope) || this.state === "idle") return;
			this.host.showToast("Voice recognition failed: Deepgram WebSocket error", "error");
			void this.stopRecording();
		});

		socket.addEventListener("close", (event) => {
			if (!this.isCurrentSocket(socket, generation, scope) || this.state === "idle") return;
			const suffix = event.code && event.code !== 1000
				? ` (${event.code}${event.reason ? `: ${event.reason}` : ""})`
				: "";
			this.host.showToast(`Voice recognition stopped: Deepgram connection closed${suffix}`, "warning");
			void this.stopRecording();
		});
	}

	private bindAudioProcess(
		audioProcess: ChildProcessByStdio<null, Readable, Readable>,
		socket: DeepgramSocket,
		generation: number,
		scope: string | undefined,
	): void {
		let stderr = "";

		audioProcess.stdout.on("data", (chunk: Buffer) => {
			if (!this.isCurrentAudioProcess(audioProcess, socket, generation, scope)) return;
			try {
				if (socket.readyState === DEEPGRAM_SOCKET_OPEN) socket.send(chunk);
			} catch (error) {
				this.host.showToast(`Voice recognition failed: ${errorMessage(error)}`, "error");
				void this.stopRecording();
			}
		});

		audioProcess.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-600);
		});

		audioProcess.once("error", (error) => {
			if (!this.isCurrentAudioProcess(audioProcess, socket, generation, scope)) return;
			if (this.state === "idle") return;
			this.host.showToast(`Voice recorder failed: ${errorMessage(error)}`, "error");
			void this.stopRecording();
		});

		audioProcess.once("close", (code, signal) => {
			if (!this.isCurrentAudioProcess(audioProcess, socket, generation, scope)) return;
			if (this.state === "idle") return;
			if (code && code !== 0) {
				const details = stderr.trim() || signal || `exit code ${code}`;
				this.host.showToast(`Voice recorder stopped: ${details}`, "warning");
			}
			void this.stopRecording();
		});
	}

	private nextLanguage(): VoiceLanguage {
		const currentIndex = this.languages.indexOf(this.language);
		const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % this.languages.length : 0;
		return this.languages[nextIndex] ?? this.language;
	}

	private initialLanguage(configuredLanguage: string | undefined): VoiceLanguage {
		if (configuredLanguage && this.languages.includes(configuredLanguage)) return configuredLanguage;
		return this.languages.includes("en") ? "en" : this.languages[0] ?? "en";
	}

	private saveLanguageSelection(language: VoiceLanguage): void {
		try {
			voiceControllerDeps.savePixDictationLanguage(language);
		} catch (error) {
			this.host.showToast(`Could not save voice language: ${errorMessage(error)}`, "warning");
		}
	}

	private languageDefinition(language: VoiceLanguage): VoiceLanguageDefinition {
		const definition = this.languageDefinitions[language];
		if (!definition) throw new Error(`dictation language is not configured: ${language}`);
		return definition;
	}

	private deepgramLanguage(language: VoiceLanguage): string {
		return this.languageDefinition(language).deepgramLanguage?.trim() || language;
	}

	private setProgressMessage(message: string, generation = this.startGeneration, scope = this.recordingScope): void {
		this.progressMessage = message;
		this.addProgressSystemMessage(message);
		if (!this.progressTimer) {
			this.progressTimer = setInterval(() => {
				if (!this.isCurrentStart(generation, scope)) return;
				this.progressFrame += 1;
				this.host.render();
			}, 120);
			this.progressTimer.unref();
		}
		this.host.render();
	}

	private clearProgressMessage(): void {
		this.progressMessage = undefined;
		this.lastSystemProgressMessage = undefined;
		if (this.progressTimer) {
			clearInterval(this.progressTimer);
			this.progressTimer = undefined;
		}
	}

	private addProgressSystemMessage(message: string): void {
		const text = `Voice input: ${message}`;
		if (text === this.lastSystemProgressMessage) return;
		this.lastSystemProgressMessage = text;
		this.host.addSystemMessage(text);
	}

	private emitPartialTranscript(
		text: string | undefined,
		socket = this.socket,
		generation = this.startGeneration,
		scope = this.recordingScope,
	): void {
		if (socket && !this.isCurrentSocket(socket, generation, scope)) return;
		if (text === this.partialTranscript) return;
		this.partialTranscript = text;
		this.schedulePartialTranscriptEmit(socket, generation, scope);
	}

	private clearPartialTranscript(scope = this.recordingScope): void {
		if (!this.partialTranscript) return;
		this.partialTranscript = undefined;
		if (this.partialTranscriptTimer) {
			clearTimeout(this.partialTranscriptTimer);
			this.partialTranscriptTimer = undefined;
		}
		if (this.isScopeActive(scope)) this.host.setPartialTranscript(undefined);
	}

	private commitPartialTranscript(scope = this.recordingScope): void {
		const text = this.partialTranscript;
		this.clearPartialTranscript(scope);
		if (text && this.isScopeActive(scope)) this.host.insertTranscript(text);
	}

	private schedulePartialTranscriptEmit(
		socket: DeepgramSocket | undefined,
		generation: number,
		scope: string | undefined,
	): void {
		if (this.partialTranscriptTimer) return;
		this.partialTranscriptTimer = setTimeout(() => {
			this.partialTranscriptTimer = undefined;
			if (socket && !this.isCurrentSocket(socket, generation, scope)) return;
			if (!this.isScopeActive(scope)) return;
			this.host.setPartialTranscript(this.partialTranscript);
		}, VOICE_PARTIAL_TRANSCRIPT_THROTTLE_MS);
		this.partialTranscriptTimer.unref?.();
	}

	private isCurrentStart(generation: number, scope = this.recordingScope): boolean {
		return this.startGeneration === generation && this.recordingScope === scope && this.isScopeActive(scope);
	}

	private continueStart(generation: number, scope: string | undefined): boolean {
		if (this.startGeneration !== generation || this.recordingScope !== scope) return false;
		if (this.isScopeActive(scope)) return true;
		this.startGeneration += 1;
		this.recordingScope = undefined;
		this.socket = undefined;
		this.clearProgressMessage();
		this.state = "idle";
		return false;
	}

	private isCurrentSocket(socket: DeepgramSocket, generation: number, scope = this.recordingScope): boolean {
		return this.startGeneration === generation
			&& this.recordingScope === scope
			&& this.socket === socket
			&& this.isScopeActive(scope);
	}

	private isCurrentAudioProcess(
		audioProcess: ChildProcessByStdio<null, Readable, Readable>,
		socket: DeepgramSocket,
		generation: number,
		scope = this.recordingScope,
	): boolean {
		return this.audioProcess === audioProcess && this.isCurrentSocket(socket, generation, scope);
	}

	private isScopeActive(scope: string | undefined): boolean {
		return this.host.activeInputScope() === scope;
	}
}

export function buildDeepgramUrl(model: string, language: string, rawLinear16: boolean): string {
	const url = new URL("wss://api.deepgram.com/v1/listen");
	url.searchParams.set("model", model.trim() || DEFAULT_DEEPGRAM_MODEL);
	url.searchParams.set("language", language.trim() || "en");
	url.searchParams.set("interim_results", "true");
	url.searchParams.set("punctuate", "true");
	url.searchParams.set("smart_format", "true");
	url.searchParams.set("vad_events", "true");
	url.searchParams.set("endpointing", "300");
	url.searchParams.set("utterance_end_ms", "1000");
	if (rawLinear16) {
		url.searchParams.set("encoding", "linear16");
		url.searchParams.set("sample_rate", String(SAMPLE_RATE));
		url.searchParams.set("channels", "1");
	}
	return url.toString();
}

export function parseDeepgramTranscript(data: unknown): DeepgramTranscript | undefined {
	const source = typeof data === "string"
		? data
		: Buffer.isBuffer(data)
			? data.toString("utf8")
			: undefined;
	if (!source) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed.type !== "Results" || !isRecord(parsed.channel)) return undefined;
	const alternatives = parsed.channel.alternatives;
	if (!Array.isArray(alternatives) || !isRecord(alternatives[0])) return undefined;
	const transcript = alternatives[0].transcript;
	if (typeof transcript !== "string") return undefined;
	const text = normalizeTranscript(transcript);
	return text ? { text, isFinal: parsed.is_final === true } : undefined;
}

async function selectRecorderCommand(): Promise<RecorderCommand> {
	const commands: RecorderCommand[] = [
		{
			command: "rec",
			args: ["-q", "-r", String(SAMPLE_RATE), "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"],
			description: "rec",
		},
		{
			command: "sox",
			args: ["-q", "-d", "-r", String(SAMPLE_RATE), "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"],
			description: "sox default device",
		},
	];

	if (process.platform === "darwin") {
		commands.push({
			command: "ffmpeg",
			args: ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", ":0", "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "-"],
			description: "ffmpeg avfoundation",
		});
	}

	if (process.platform === "linux") {
		commands.push(
			{
				command: "ffmpeg",
				args: ["-hide_banner", "-loglevel", "error", "-f", "alsa", "-i", "default", "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "-"],
				description: "ffmpeg alsa",
			},
			{
				command: "arecord",
				args: ["-q", "-r", String(SAMPLE_RATE), "-c", "1", "-f", "S16_LE", "-t", "raw"],
				description: "arecord",
			},
		);
	}

	for (const candidate of commands) {
		if (await commandExists(candidate.command)) return candidate;
	}
	throw new Error("audio recorder not found: install SoX (`rec`/`sox`), ffmpeg, or arecord");
}

function createDeepgramSocket(url: string, protocols: string[]): DeepgramSocket {
	type WebSocketConstructor = new (url: string, protocols?: string | string[]) => DeepgramSocket;
	const WebSocketConstructor = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
	if (!WebSocketConstructor) throw new Error("this Node runtime does not provide WebSocket support");
	return new WebSocketConstructor(url, protocols);
}

async function waitForSocketOpen(socket: DeepgramSocket): Promise<void> {
	if (socket.readyState === DEEPGRAM_SOCKET_OPEN) return;
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			if (error) reject(error);
			else resolve();
		};
		const onOpen: DeepgramSocketListener = () => finish();
		const onError: DeepgramSocketListener = () => finish(new Error("Deepgram WebSocket connection failed"));
		const onClose: DeepgramSocketListener = (event) => finish(new Error(
			`Deepgram WebSocket closed before connecting${event.code ? ` (${event.code}${event.reason ? `: ${event.reason}` : ""})` : ""}`,
		));
		const timer = setTimeout(() => finish(new Error("Deepgram WebSocket connection timed out")), DEEPGRAM_SOCKET_CONNECT_TIMEOUT_MS);
		timer.unref?.();
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
	});
}

function safeCloseSocket(socket: DeepgramSocket): void {
	try {
		socket.close(1000, "voice input stopped");
	} catch {
		// Best-effort cleanup.
	}
}

async function stopRecorderProcess(
	audioProcess: ChildProcessByStdio<null, Readable, Readable>,
): Promise<void> {
	if (audioProcess.exitCode !== null) return;
	const gracefulClose = waitForProcessClose(audioProcess, RECORDER_STOP_GRACE_MS);
	if (!audioProcess.killed) safeKillProcess(audioProcess, "SIGTERM");
	if (await gracefulClose) return;
	if (audioProcess.exitCode === null) safeKillProcess(audioProcess, "SIGKILL");
	await waitForProcessClose(audioProcess, RECORDER_FORCE_STOP_GRACE_MS);
}

function waitForProcessClose(
	audioProcess: ChildProcessByStdio<null, Readable, Readable>,
	timeoutMs: number,
): Promise<boolean> {
	if (audioProcess.exitCode !== null) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (closed: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			audioProcess.removeListener("close", onClose);
			resolve(closed);
		};
		const onClose = (): void => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		timer.unref?.();
		audioProcess.once("close", onClose);
	});
}

function safeKillProcess(
	audioProcess: ChildProcessByStdio<null, Readable, Readable>,
	signal: NodeJS.Signals,
): void {
	try {
		audioProcess.kill(signal);
	} catch {
		// Best-effort cleanup; shutdown has its own outer deadline.
	}
}

function normalizeTranscript(text: string): string | undefined {
	const normalized = text.trim().replace(/\s+/gu, " ");
	return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

async function delay(ms: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
