import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, SimpleStreamOptions, ToolCall } from "@earendil-works/pi-ai";

export const PRIVATE_TRANSPORT_ERROR = "Claude Code proposed a Pi tool call against provider-private transport state";
export const IMAGE_READ_CORRECTION = "Provider transport correction: every image in this request is already attached and visible to you. Inspect the attached images directly. Do not call Read/read or any other Pi tool on generated attachment paths or provider-private files. Your previous image Read proposal was rejected internally; no Pi tool ran. Continue the original user task using the attachments, or explain if you cannot interpret them.";

/** Exact current-request membership, never a prefix/filename/suffix allowlist. */
export function onlyAttachedImageReads(message: AssistantMessage, attachments: readonly string[]): boolean {
  const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
  return calls.length > 0 && calls.every((call) => {
    if (call.name !== "Read" && call.name !== "read") return false;
    const args = call.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) return false;
    const keys = Object.keys(args);
    if (keys.length !== 1 || (keys[0] !== "path" && keys[0] !== "file_path")) return false;
    const path = args[keys[0]!];
    return typeof path === "string" && attachments.includes(path);
  });
}

export interface ImageReadAttempt {
  correction: boolean;
  onPrepared: (hasImages: boolean) => void;
  onRecoverable: () => void;
  onSettled: () => void;
  remainingTimeoutMs: () => number | undefined;
}

/**
 * Image-bearing attempts are held until settlement: an unsafe tool proposal must
 * never appear in Pi's stream/transcript. Text-only requests still stream live.
 * Retry once, only after verified process death AND complete resource finalization.
 */
export function recoverImageRead(
  launch: (attempt: ImageReadAttempt, options?: SimpleStreamOptions) => AssistantMessageEventStream,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const started = performance.now();
  const remainingTimeoutMs = (): number | undefined => options?.timeoutMs && options.timeoutMs > 0
    ? options.timeoutMs - (performance.now() - started) : undefined;
  void (async () => {
    let previousUsage: AssistantMessage["usage"] | undefined;
    let lastMessage: AssistantMessage | undefined;
    try {
      for (let index = 0; index < 2; index++) {
        let hasImages = true; // fail closed until preparation reports the actual effective payload
        let recoverable = false;
        let resolveSettled!: () => void;
        const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
        const remaining = remainingTimeoutMs();
        const source = launch({
          correction: index > 0,
          onPrepared: (value) => { hasImages = value; },
          onRecoverable: () => { recoverable = true; },
          onSettled: resolveSettled,
          remainingTimeoutMs,
        }, remaining === undefined ? options : { ...options, timeoutMs: Math.max(1, remaining) });
        const held: AssistantMessageEvent[] = [];
        for await (const event of source) {
          if (hasImages) held.push(event);
          else stream.push(event);
        }
        await settled;
        const message = await source.result();
        lastMessage = message;
        if (!hasImages) { stream.end(); return; }
        const timeLeft = (remainingTimeoutMs() ?? Infinity) > 0;
        if (index === 0 && recoverable && message.stopReason === "error" &&
            message.errorMessage === PRIVATE_TRANSPORT_ERROR && !options?.signal?.aborted && timeLeft) {
          previousUsage = structuredClone(message.usage);
          continue;
        }
        // Neither an exhausted correction nor an unrelated private-state failure
        // publishes executable proposals (including safe siblings of an unsafe call).
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          message.content = message.content.filter((block) => block.type !== "toolCall");
          if (previousUsage) addUsage(message.usage, previousUsage);
          // Removing tool blocks changes content indices: publish a coherent
          // terminal snapshot rather than stale indexed progress events.
          stream.push({ type: "start", partial: message });
          stream.push({ type: "error", reason: message.stopReason, error: message });
          stream.end();
          return;
        }
        if (previousUsage) addUsage(message.usage, previousUsage);
        for (const event of held) stream.push(event);
        stream.end();
        return;
      }
    } catch (error) {
      // All normal provider failures are terminal events. An unexpected wrapper
      // failure must still settle the outer stream rather than leave Pi hanging.
      const failure = lastMessage ?? emptyFailure();
      failure.content = failure.content.filter((block) => block.type !== "toolCall");
      failure.stopReason = options?.signal?.aborted ? "aborted" : "error";
      failure.errorMessage = `Image-read recovery failed: ${error instanceof Error ? error.message : String(error)}`;
      stream.push({ type: "error", reason: failure.stopReason, error: failure });
      stream.end();
    }
  })();
  return stream;
}

function emptyFailure(): AssistantMessage {
  return { role: "assistant", content: [], api: "pi-claude-code-provider-headless" as AssistantMessage["api"],
    provider: "pi-claude-code-provider", model: "unknown", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error" };
}

function addUsage(target: AssistantMessage["usage"], previous: AssistantMessage["usage"]): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) target[key] += previous[key];
  for (const key of ["reasoning", "cacheWrite1h"] as const) {
    if (previous[key] !== undefined) target[key] = (target[key] ?? 0) + previous[key];
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target.cost[key] += previous.cost[key];
}
