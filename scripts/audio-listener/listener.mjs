import { access, chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runProcess } from "./process.mjs";

export const models = { ru: "vosk-model-small-ru-0.22", en: "vosk-model-small-en-us-0.15" };
export function runtimePaths() {
    const home = process.env.PIX_LISTENER_HOME || join(homedir(), "Library/Caches/Pix/local-listener");
    return {
        native: join(home, "listener-native"), vosk: join(home, "vosk-runner"),
        library: join(home, "libvosk.dylib"),
        models: join(homedir(), "Library/Caches/Pix/listener-feasibility/vosk"),
    };
}

export function parseRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid listener request");
    const allowed = value.operation === "file" ? ["operation", "language", "path"]
        : value.operation === "microphone" ? ["operation", "language", "seconds"] : ["operation"];
    if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unsupported listener parameter");
    if (value.operation === "status") return { operation: "status" };
    if (!["file", "microphone"].includes(value.operation)) throw new Error("Choose file or microphone");
    if (!Object.hasOwn(models, value.language)) throw new Error("Choose language ru or en explicitly");
    if (value.operation === "file") {
        if (typeof value.path !== "string" || !isAbsolute(value.path) || value.path.includes("\0")) {
            throw new Error("Provide an absolute local audio file path");
        }
        return { operation: "file", language: value.language, path: value.path };
    }
    const seconds = value.seconds ?? 30;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) throw new Error("Recording must be 1–120 seconds");
    return { operation: "microphone", language: value.language, seconds };
}

export async function checkRuntime(paths, language) {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Local listener currently requires macOS arm64");
    try {
        await Promise.all([access(paths.native, constants.X_OK), access(paths.vosk, constants.X_OK), access(paths.library)]);
        for (const lang of language ? [language] : ["ru", "en"]) {
            await access(join(paths.models, models[lang], "am/final.mdl"));
        }
    } catch {
        throw new Error("Local Vosk helpers/models are missing. Run the documented local listener setup; nothing was downloaded.");
    }
}

export function normalizeTranscript(raw, language, duration) {
    const parts = JSON.parse(raw);
    if (!Array.isArray(parts)) throw new Error("Invalid Vosk result");
    const words = [];
    let end = 0;
    for (const part of parts) {
        if (!part || typeof part.text !== "string" || (part.result !== undefined && !Array.isArray(part.result))) {
            throw new Error("Invalid Vosk result");
        }
        for (const word of part.result ?? []) {
            if (!word || typeof word.word !== "string" || !Number.isFinite(word.start) || !Number.isFinite(word.end)
                || word.start < end || word.end <= word.start || word.end > duration + 0.05
                || !Number.isFinite(word.conf) || word.conf < 0 || word.conf > 1) throw new Error("Invalid Vosk word timing");
            words.push({ text: word.word, start: word.start, end: word.end, confidence: word.conf });
            end = word.end;
        }
    }
    return { engine: "vosk", language, model: models[language], durationSeconds: duration,
        text: parts.map((part) => part.text).filter(Boolean).join(" ").trim(), words };
}

// One bounded invocation, no server, persistent queue, cloud client or downloader.
export async function transcribe(request, { cwd, paths, signal, progress = (_text) => {}, run = runProcess }) {
    signal.throwIfAborted();
    const root = join(cwd, ".pi/artifacts");
    await mkdir(root, { recursive: true });
    const work = await mkdtemp(join(root, "listener-audio-"));
    try {
        await chmod(work, 0o700);
        let source = request.path;
        if (request.operation === "microphone") {
            source = join(work, "microphone.caf");
            progress("Waiting for microphone permission; Stop cancels");
            await run(paths.native, ["microphone", String(request.seconds), source], {
                signal, timeout: (request.seconds + 75) * 1000, input: "PIX_LISTENER_MICROPHONE_CONFIRMED\n",
                onRecording: () => progress(`Recording microphone for ${request.seconds}s; Stop cancels`),
            });
        }
        signal.throwIfAborted();
        const info = await stat(source);
        if (!info.isFile() || info.size === 0 || info.size > 512 * 1024 * 1024) throw new Error("Expected a nonempty audio file up to 512 MiB");
        const pcm = join(work, "audio.pcm");
        progress("Decoding audio locally");
        try { await run(paths.native, ["decode", source, pcm], { signal }); }
        catch (error) {
            signal.throwIfAborted();
            throw new Error("Audio decode failed: use a single-track PCM or AAC-LC file up to 120 seconds", { cause: error });
        }
        signal.throwIfAborted();
        const { size } = await stat(pcm);
        if (size === 0 || size % 2 || size > 120 * 32000) throw new Error("Invalid decoded audio length");
        progress("Recognizing locally with Vosk");
        const raw = await run(paths.vosk, [paths.library, join(paths.models, models[request.language]), pcm], { signal });
        signal.throwIfAborted();
        return normalizeTranscript(raw, request.language, size / 32000);
    } finally {
        await rm(work, { recursive: true, force: true });
    }
}
