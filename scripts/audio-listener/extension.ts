import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { suiteDiagnostics } from "../../external/pi-tools-suite/src/lib/suite-diagnostics.js";
import { checkRuntime, parseRequest, runtimePaths, transcribe } from "./listener.mjs";
import { waitForConsent } from "./process.mjs";

export default function listenerExtension(pi: ExtensionAPI) {
    let active: AbortController | undefined;
    let done: Promise<void> | undefined;
    let closed = false;
    const cancel = () => { active?.abort(); };
    pi.on("session_before_switch", cancel);
    pi.on("session_shutdown", async (_event, ctx) => {
        closed = true;
        const pending = done;
        cancel();
        if (!pending) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const cleaned = await Promise.race([
                pending.then(() => true),
                new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3000); }),
            ]);
            if (!cleaned) suiteDiagnostics.report("warn", "listener", "shutdown-cleanup-timeout", ctx.cwd, {}, ctx);
        } finally { clearTimeout(timer); }
    });
    pi.registerTool({
        name: "listener", label: "Local Vosk listener",
        description: "Offline Vosk speech transcription, RU or EN. operation=status checks setup; file reads a local absolute audio path; microphone records the default input only after a user confirmation dialog. Explicit language required, max 120 seconds. No system audio, cloud, auto-downloads or continuous listening. Audio is deleted after processing; transcript enters this chat and may be sent to its LLM. Stop cancels and discards the recording. For simple transcription call directly, not a subagent.",
        parameters: Type.Object({
            operation: Type.Union([Type.Literal("status"), Type.Literal("file"), Type.Literal("microphone")]),
            language: Type.Optional(Type.Union([Type.Literal("ru"), Type.Literal("en")])),
            path: Type.Optional(Type.String()), seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
        }, { additionalProperties: false }),
        async execute(_id, params, signal, update, ctx) {
            if (closed) throw new Error("Listener session is closed");
            if (active) throw new Error("Listener is busy in this session");
            const owner = new AbortController();
            let finish!: () => void;
            done = new Promise<void>((resolve) => { finish = resolve; });
            active = owner;
            const abort = () => owner.abort();
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) owner.abort();
            const progress = (text: string) => update?.({ content: [{ type: "text", text }], details: {} });
            try {
                const request = parseRequest(params);
                const paths = runtimePaths();
                owner.signal.throwIfAborted();
                await checkRuntime(paths, request.language);
                owner.signal.throwIfAborted();
                if (request.operation === "status") return {
                    content: [{ type: "text", text: "Local Vosk ready: RU/EN, audio file or confirmed microphone, max 120s." }], details: {},
                };
                if (request.operation === "microphone") {
                    if (!ctx.hasUI) throw new Error("Microphone requires an interactive user confirmation");
                    owner.signal.throwIfAborted();
                    const approved = await waitForConsent(ctx.ui.confirm("Записать микрофон?",
                        `Запись default input на ${request.seconds} с. Проверьте, что выбран микрофон, не loopback. Vosk работает локально; текст попадёт в чат и его LLM. Аудио удаляется. Stop отменяет запись.`,
                        { signal: owner.signal }), owner.signal);
                    owner.signal.throwIfAborted();
                    if (!approved) throw new Error("Microphone recording declined");
                }
                const result = await transcribe(request, { cwd: ctx.cwd, paths, signal: owner.signal, progress });
                owner.signal.throwIfAborted();
                return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
            } catch (error) {
                suiteDiagnostics.report(owner.signal.aborted ? "debug" : "warn", "listener", "operation-failed", ctx.cwd, {}, ctx);
                throw error;
            } finally {
                signal?.removeEventListener("abort", abort);
                if (active === owner) { active = undefined; done = undefined; }
                finish();
            }
        },
    });
}
