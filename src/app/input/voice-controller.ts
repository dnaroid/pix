import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { savePixDictationLanguage, type DictationConfig, type DictationLanguageModelConfig } from "../../config.js";
import { APP_ICONS } from "../icons.js";
import { commandExists } from "../process.js";

export type VoiceLanguage = string;
export type VoiceInputState = "idle" | "installing" | "downloading" | "loading" | "listening";

export type AppVoiceControllerHost = {
	insertTranscript(text: string): void;
	setPartialTranscript(text: string | undefined): void;
	addSystemMessage(message: string): void;
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	render(): void;
};

type VoskRecognitionResult = string | { text?: unknown; partial?: unknown };

type VoskModel = {
	free?: () => void;
};

type VoskRecognizer = {
	acceptWaveform(buffer: Buffer): boolean;
	partialResult?: () => VoskRecognitionResult;
	result(): VoskRecognitionResult;
	finalResult(): VoskRecognitionResult;
	free?: () => void;
};

type VoskModule = {
	Model: new (modelPath: string) => VoskModel;
	Recognizer: new (options: { model: VoskModel; sampleRate: number }) => VoskRecognizer;
	setLogLevel?: (level: number) => void;
};

type VoskLoadAttempt =
	| { ok: true; module: VoskModule }
	| { ok: false; error: unknown };

type VoskInstallProgress = (message: string) => void;

type VoiceModelDefinition = DictationLanguageModelConfig;

type RecorderCommand = {
	command: string;
	args: string[];
	description: string;
};

const SAMPLE_RATE = 16_000;
const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const modelsRoot = join(projectRoot, "models", "vosk");
const VOSK_PACKAGE_SPEC = "vosk@0.3.39";
const VOICE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const VOICE_PARTIAL_TRANSCRIPT_THROTTLE_MS = 100;

let voskInstallPromise: Promise<string> | undefined;

type VoiceControllerTestDeps = {
	tryLoadVosk: typeof tryLoadVosk;
	ensureModel: typeof ensureModel;
	selectRecorderCommand: typeof selectRecorderCommand;
	spawn: typeof spawn;
	savePixDictationLanguage: typeof savePixDictationLanguage;
};

const defaultVoiceControllerDeps: VoiceControllerTestDeps = {
	tryLoadVosk,
	ensureModel,
	selectRecorderCommand,
	spawn,
	savePixDictationLanguage,
};

let voiceControllerDeps = defaultVoiceControllerDeps;

export function setVoiceControllerTestDeps(overrides?: Partial<VoiceControllerTestDeps>): void {
	voiceControllerDeps = overrides ? { ...defaultVoiceControllerDeps, ...overrides } : defaultVoiceControllerDeps;
}

export class AppVoiceController {
	private readonly modelDefinitions: Record<VoiceLanguage, VoiceModelDefinition>;
	private readonly languages: VoiceLanguage[];
	private language: VoiceLanguage;
	private state: VoiceInputState = "idle";
	private readonly modelCache = new Map<VoiceLanguage, VoskModel>();
	private audioProcess: ChildProcessByStdio<null, Readable, Readable> | undefined;
	private recognizer: VoskRecognizer | undefined;
	private progressMessage: string | undefined;
	private progressFrame = 0;
	private progressTimer: ReturnType<typeof setInterval> | undefined;
	private lastSystemProgressMessage: string | undefined;
	private partialTranscript: string | undefined;
	private partialTranscriptTimer: ReturnType<typeof setTimeout> | undefined;
	private startGeneration = 0;

	constructor(private readonly host: AppVoiceControllerHost, dictationConfig: DictationConfig) {
		this.modelDefinitions = dictationConfig.languages;
		this.languages = Object.keys(this.modelDefinitions);
		this.language = this.initialLanguage(dictationConfig.language);
	}

	statusWidgetText(): string {
		const languageLabel = this.showLanguageSwitcher() ? ` ${this.language.toUpperCase()}` : "";
		switch (this.state) {
			case "installing":
				return `${APP_ICONS.microphone}${languageLabel} ${APP_ICONS.timerSand}`;
			case "downloading":
				return `${APP_ICONS.down}${languageLabel}`;
			case "loading":
				return `${APP_ICONS.microphone}${languageLabel} ${APP_ICONS.timerSand}`;
			case "listening":
				return `${APP_ICONS.microphone}${languageLabel}`;
			case "idle":
				return `${APP_ICONS.microphone}${languageLabel}`;
		}
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
		if (this.state !== "idle") {
			await this.stopRecording();
			return;
		}

		await this.startRecording();
	}

	async toggleLanguage(): Promise<void> {
		if (!this.showLanguageSwitcher()) return;

		const wasActive = this.state !== "idle";
		if (wasActive) await this.stopRecording();

		this.language = this.nextLanguage();
		this.saveLanguageSelection(this.language);
		this.host.showToast(`Voice language: ${this.modelDefinition(this.language).label}`, "info");
		this.host.render();

		if (wasActive) void this.startRecording();
	}

	async stopRecording(): Promise<void> {
		this.startGeneration += 1;
		const audioProcess = this.audioProcess;
		const recognizer = this.recognizer;
		this.audioProcess = undefined;
		this.recognizer = undefined;

		if (audioProcess && !audioProcess.killed) audioProcess.kill("SIGTERM");
		if (recognizer) {
			this.clearPartialTranscript();
			this.emitTranscript(recognizer.finalResult());
			recognizer.free?.();
		}

		if (this.state !== "idle") {
			this.clearProgressMessage();
			this.state = "idle";
			this.host.render();
		}
	}

	async dispose(): Promise<void> {
		await this.stopRecording();
		for (const model of this.modelCache.values()) model.free?.();
		this.modelCache.clear();
	}

	private async startRecording(): Promise<void> {
		const language = this.language;
		const generation = this.startGeneration + 1;
		this.startGeneration = generation;

		try {
			const initialVosk = voiceControllerDeps.tryLoadVosk();
			const vosk = initialVosk.ok
				? initialVosk.module
				: await this.installAndLoadVosk(initialVosk.error, generation);
			if (!this.isCurrentStart(generation)) return;
			vosk.setLogLevel?.(-1);

			this.state = "downloading";
			this.host.render();
			const modelPath = await voiceControllerDeps.ensureModel(language, this.modelDefinition(language));
			if (!this.isCurrentStart(generation)) return;

			this.state = "loading";
			this.host.render();
			const model = this.cachedModel(language, modelPath, vosk);
			const recorder = await voiceControllerDeps.selectRecorderCommand();
			const recognizer = new vosk.Recognizer({ model, sampleRate: SAMPLE_RATE });
			const audioProcess = voiceControllerDeps.spawn(recorder.command, recorder.args, { stdio: ["ignore", "pipe", "pipe"] });
			this.recognizer = recognizer;
			this.audioProcess = audioProcess;
			this.state = "listening";
			this.host.render();
			this.host.showToast(`Voice input on (${this.modelDefinition(language).label}, ${recorder.description})`, "info");

			this.bindAudioProcess(audioProcess, recognizer, generation);
		} catch (error) {
			if (!this.isCurrentStart(generation)) return;
			this.clearProgressMessage();
			this.cleanupRecognizer();
			this.state = "idle";
			this.addProgressSystemMessage(`Unavailable: ${errorMessage(error)}`);
			this.host.showToast(`Voice input unavailable: ${errorMessage(error)}`, "error");
			this.host.render();
		}
	}

	private cachedModel(language: VoiceLanguage, modelPath: string, vosk: VoskModule): VoskModel {
		const cached = this.modelCache.get(language);
		if (cached) return cached;

		const model = new vosk.Model(modelPath);
		this.modelCache.set(language, model);
		return model;
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

	private modelDefinition(language: VoiceLanguage): VoiceModelDefinition {
		const definition = this.modelDefinitions[language];
		if (!definition) throw new Error(`dictation language is not configured: ${language}`);
		return definition;
	}

	private async installAndLoadVosk(initialError: unknown, generation: number): Promise<VoskModule> {
		this.state = "installing";
		this.setProgressMessage("Installing Vosk voice bindings...");
		const vosk = await loadVoskWithAutoInstall(initialError, (message) => {
			if (this.isCurrentStart(generation)) this.setProgressMessage(message);
		});
		if (this.isCurrentStart(generation)) this.addProgressSystemMessage("Vosk voice bindings are ready.");
		if (this.isCurrentStart(generation)) this.clearProgressMessage();
		return vosk;
	}

	private bindAudioProcess(audioProcess: ChildProcessByStdio<null, Readable, Readable>, recognizer: VoskRecognizer, generation: number): void {
		let stderr = "";

		audioProcess.stdout.on("data", (chunk: Buffer) => {
			if (!this.isCurrentAudioProcess(audioProcess, recognizer, generation)) return;
			try {
				if (recognizer.acceptWaveform(chunk)) {
					this.clearPartialTranscript();
					this.emitTranscript(recognizer.result());
				} else {
					this.emitPartialTranscript(recognizer.partialResult?.());
				}
			} catch (error) {
				this.host.showToast(`Voice recognition failed: ${errorMessage(error)}`, "error");
				void this.stopRecording();
			}
		});

		audioProcess.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-600);
		});

		audioProcess.once("error", (error) => {
			if (!this.isCurrentAudioProcess(audioProcess, recognizer, generation)) return;
			this.clearPartialTranscript();
			this.cleanupRecognizer();
			this.audioProcess = undefined;
			this.state = "idle";
			this.host.showToast(`Voice recorder failed: ${errorMessage(error)}`, "error");
			this.host.render();
		});

		audioProcess.once("close", (code, signal) => {
			if (!this.isCurrentAudioProcess(audioProcess, recognizer, generation)) return;
			this.clearPartialTranscript();
			this.emitTranscript(recognizer.finalResult());
			this.cleanupRecognizer();
			this.audioProcess = undefined;
			this.state = "idle";
			if (code && code !== 0) {
				const details = stderr.trim() || signal || `exit code ${code}`;
				this.host.showToast(`Voice recorder stopped: ${details}`, "warning");
			}
			this.host.render();
		});
	}

	private cleanupRecognizer(): void {
		this.recognizer?.free?.();
		this.recognizer = undefined;
	}

	private setProgressMessage(message: string): void {
		this.progressMessage = message;
		this.addProgressSystemMessage(message);
		if (!this.progressTimer) {
			this.progressTimer = setInterval(() => {
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

	private emitTranscript(result: VoskRecognitionResult): void {
		const text = transcriptText(result);
		if (!text) return;
		this.host.insertTranscript(text);
	}

	private emitPartialTranscript(result: VoskRecognitionResult | undefined): void {
		const text = partialTranscriptText(result);
		if (text === this.partialTranscript) return;
		this.partialTranscript = text;
		this.schedulePartialTranscriptEmit();
	}

	private clearPartialTranscript(): void {
		if (!this.partialTranscript) return;
		this.partialTranscript = undefined;
		if (this.partialTranscriptTimer) {
			clearTimeout(this.partialTranscriptTimer);
			this.partialTranscriptTimer = undefined;
		}
		this.host.setPartialTranscript(undefined);
	}

	private schedulePartialTranscriptEmit(): void {
		if (this.partialTranscriptTimer) return;
		this.partialTranscriptTimer = setTimeout(() => {
			this.partialTranscriptTimer = undefined;
			this.host.setPartialTranscript(this.partialTranscript);
		}, VOICE_PARTIAL_TRANSCRIPT_THROTTLE_MS);
		this.partialTranscriptTimer.unref?.();
	}

	private isCurrentStart(generation: number): boolean {
		return this.startGeneration === generation;
	}

	private isCurrentAudioProcess(audioProcess: ChildProcessByStdio<null, Readable, Readable>, recognizer: VoskRecognizer, generation: number): boolean {
		return this.startGeneration === generation && this.audioProcess === audioProcess && this.recognizer === recognizer;
	}
}

async function ensureModel(language: VoiceLanguage, definition: VoiceModelDefinition): Promise<string> {
	const modelPath = join(modelsRoot, definition.dirName);
	if (await looksLikeVoskModel(modelPath)) return modelPath;

	await mkdir(modelsRoot, { recursive: true });
	const zipPath = join(modelsRoot, `${definition.dirName}.zip`);
	const tempPath = join(modelsRoot, `${definition.dirName}.tmp-${process.pid}-${Date.now()}`);

	await rm(zipPath, { force: true });
	await rm(tempPath, { recursive: true, force: true });
	await downloadFile(definition.url, zipPath);
	await mkdir(tempPath, { recursive: true });
	await extractZip(zipPath, tempPath);

	const extractedPath = join(tempPath, definition.dirName);
	if (!(await looksLikeVoskModel(extractedPath))) {
		await rm(tempPath, { recursive: true, force: true });
		await rm(zipPath, { force: true });
		throw new Error(`downloaded ${definition.label} (${language}) model did not contain a valid Vosk model`);
	}

	await rm(modelPath, { recursive: true, force: true });
	await rename(extractedPath, modelPath);
	await rm(tempPath, { recursive: true, force: true });
	await rm(zipPath, { force: true });
	return modelPath;
}

async function looksLikeVoskModel(modelPath: string): Promise<boolean> {
	return (await pathExists(join(modelPath, "conf", "model.conf"))) && (await pathExists(join(modelPath, "am", "final.mdl")));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function downloadFile(url: string, destination: string, redirects = 3): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const client = url.startsWith("https:") ? https : http;
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			callback();
		};
		const request = client.get(url, (response) => {
			const statusCode = response.statusCode ?? 0;
			const location = response.headers.location;
			if ([301, 302, 303, 307, 308].includes(statusCode) && location && redirects > 0) {
				response.resume();
				const redirectedUrl = new URL(location, url).toString();
				downloadFile(redirectedUrl, destination, redirects - 1).then(
					() => finish(resolve),
					(error) => finish(() => reject(error)),
				);
				return;
			}

			if (statusCode !== 200) {
				response.resume();
				finish(() => reject(new Error(`download failed with HTTP ${statusCode}`)));
				return;
			}

			const file = createWriteStream(destination);
			response.on("error", (error) => {
				finish(() => reject(error));
			});
			pipeline(response, file).then(
				() => finish(resolve),
				(error) => finish(() => reject(error)),
			);
		});

		request.on("error", (error) => {
			finish(() => reject(error));
		});
	});
}

async function extractZip(zipPath: string, destination: string): Promise<void> {
	if (await commandExists("unzip")) {
		await runCommand("unzip", ["-q", zipPath, "-d", destination]);
		return;
	}

	if (process.platform === "darwin" && await commandExists("ditto")) {
		await runCommand("ditto", ["-x", "-k", zipPath, destination]);
		return;
	}

	throw new Error("cannot extract Vosk model: install `unzip` (or `ditto` on macOS)");
}

async function runCommand(command: string, args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-600);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
		});
	});
}

async function loadVoskWithAutoInstall(initialError: unknown, progress: VoskInstallProgress): Promise<VoskModule> {
	const installOutput = await ensureVoskInstalled(progress, initialError);

	const attempt = tryLoadVosk();
	if (attempt.ok) return attempt.module;

	throw new Error(`automatic Vosk install/build finished, but bindings still cannot load: ${errorMessage(attempt.error)}${installDiagnosticSuffix(installOutput)}`);
}

async function ensureVoskInstalled(progress: VoskInstallProgress, initialError: unknown): Promise<string> {
	if (voskInstallPromise) {
		progress("Waiting for Vosk install already in progress...");
		await voskInstallPromise;
		return "";
	}

	voskInstallPromise = installVoskBindings(progress, initialError).finally(() => {
		voskInstallPromise = undefined;
	});
	return await voskInstallPromise;
}

async function installVoskBindings(progress: VoskInstallProgress, initialError: unknown): Promise<string> {
	progress(`Installing Vosk bindings (${VOSK_PACKAGE_SPEC})...`);
	let installOutput = "";
	try {
		installOutput = await runNpmCommand(
			["install", "--no-save", "--package-lock=false", VOSK_PACKAGE_SPEC, "--ignore-scripts"],
			"Installing Vosk",
			progress,
		);
		await patchVoskNativeDependencies(progress);
		progress("Building Vosk native dependencies...");
		const rebuildOutput = await runNpmCommand(["rebuild", "ffi-napi", "ref-napi", "--foreground-scripts", "--ignore-scripts=false"], "Building Vosk", progress);

		const installedAttempt = tryLoadVosk();
		if (installedAttempt.ok) return `${installOutput}\n${rebuildOutput}`;
		if (isMissingModuleError(installedAttempt.error)) {
			throw new Error(`npm install finished without a loadable Vosk package: ${errorMessage(installedAttempt.error)}${installDiagnosticSuffix(`${installOutput}\n${rebuildOutput}`)}`);
		}

		progress("Rebuilding Vosk package...");
		const voskRebuildOutput = await runNpmCommand(["rebuild", "vosk", "--foreground-scripts", "--ignore-scripts=false"], "Building Vosk", progress);
		return `${installOutput}\n${rebuildOutput}\n${voskRebuildOutput}`;
	} catch (error) {
		throw new Error(`automatic Vosk install/build failed: ${errorMessage(error)} (initial load error: ${errorMessage(initialError)})`);
	}
}

async function patchVoskNativeDependencies(progress: VoskInstallProgress): Promise<void> {
	const headerPath = join(projectRoot, "node_modules", "get-uv-event-loop-napi-h", "include", "get-uv-event-loop-napi.h");
	let source: string;
	try {
		source = await readFile(headerPath, "utf8");
	} catch {
		return;
	}

	const oldLine = "napi_get_uv_event_loop__ = &napi_get_uv_event_loop;";
	const newLine = "napi_get_uv_event_loop__ = (get_uv_event_loop_fn)&napi_get_uv_event_loop;";
	if (source.includes(newLine)) return;
	if (!source.includes(oldLine)) return;

	await writeFile(headerPath, source.replace(oldLine, newLine));
	progress("Patched Vosk native headers for Node 24...");
}

async function runNpmCommand(args: string[], label: string, progress: VoskInstallProgress): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(npmCommand(), args, {
			cwd: projectRoot,
			env: { ...process.env, npm_config_ignore_scripts: "false" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";

		const observeOutput = (chunk: Buffer): void => {
			const text = chunk.toString("utf8");
			output = `${output}${text}`.slice(-1200);
			const line = lastUsefulLine(text);
			if (line) progress(`${label}: ${line}`);
		};

		child.stdout.on("data", observeOutput);
		child.stderr.on("data", observeOutput);
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve(output);
			else reject(new Error(`${npmCommand()} ${args.join(" ")} failed${output.trim() ? `: ${output.trim()}` : ""}`));
		});
	});
}

function isMissingModuleError(error: unknown): boolean {
	return /Cannot find module ['"]vosk['"]/u.test(errorMessage(error));
}

function installDiagnosticSuffix(output: string): string {
	const summary = compactOutputSummary(output);
	const nodeHint = nodeVersionCompatibilityHint(output);
	return `${summary ? ` Last npm output: ${summary}` : ""}${nodeHint ? ` ${nodeHint}` : ""}`;
}

function compactOutputSummary(output: string): string {
	const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
	const interesting = lines.filter((line) => /\b(error|ERR!|failed|not ok|incompatible|Cannot find|node-gyp|make:)\b/iu.test(line));
	const selected = (interesting.length > 0 ? interesting : lines).slice(-8);
	const summary = selected.join(" | ");
	return summary.length > 900 ? `${summary.slice(0, 897)}...` : summary;
}

function nodeVersionCompatibilityHint(output: string): string | undefined {
	const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
	if (nodeMajor >= 25 && /ffi-napi|node-gyp|napi_add_finalizer|get_uv_event_loop/iu.test(output)) {
		return `Detected Node ${process.versions.node}; Vosk npm bindings depend on ffi-napi, which may not build on this Node version. Try running Pix with Node 22 or 24.`;
	}
	return undefined;
}

function lastUsefulLine(text: string): string | undefined {
	const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
	const line = lines.at(-1);
	if (!line) return undefined;
	return line.length > 96 ? `${line.slice(0, 93)}...` : line;
}

function npmCommand(): string {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function tryLoadVosk(): VoskLoadAttempt {
	try {
		return { ok: true, module: loadVosk() };
	} catch (error) {
		return { ok: false, error };
	}
}

function loadVosk(): VoskModule {
	let moduleValue: unknown;
	try {
		moduleValue = require("vosk");
	} catch (error) {
		throw new Error(`local Vosk bindings are not ready: ${errorMessage(error)}`);
	}

	if (!isVoskModule(moduleValue)) throw new Error("installed `vosk` package does not expose Model and Recognizer");
	return moduleValue;
}

function isVoskModule(value: unknown): value is VoskModule {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.Model === "function" && typeof record.Recognizer === "function";
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

function transcriptText(result: VoskRecognitionResult): string | undefined {
	const parsed = typeof result === "string" ? parseResultString(result) : result;
	const text = parsed && typeof parsed.text === "string" ? parsed.text.trim().replace(/\s+/gu, " ") : "";
	return text || undefined;
}

function partialTranscriptText(result: VoskRecognitionResult | undefined): string | undefined {
	const parsed = typeof result === "string" ? parseResultString(result) : result;
	const text = parsed && typeof parsed.partial === "string" ? parsed.partial.trim().replace(/\s+/gu, " ") : "";
	return text || undefined;
}

function parseResultString(result: string): { text?: unknown; partial?: unknown } | undefined {
	try {
		const parsed: unknown = JSON.parse(result);
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
