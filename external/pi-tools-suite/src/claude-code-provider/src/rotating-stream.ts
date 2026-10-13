import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { accountRotationState, DEFAULT_ROTATION_DELAY_SECONDS, loadClaudeAccountRotationConfig, type ClaudeAccountRotationConfig, type ClaudeAccountRotationState } from "./account-rotation.ts";
import type { RateLimitNotice, RateLimitNoticeSink } from "./claude-protocol.ts";
import { createOutput } from "./output.ts";
import { waitForRotationDelay } from "./rotation-delay.ts";
import { createClaudeStream, type ClaudeStreamDependencies } from "./provider.ts";
import type { ClaudeInstallation } from "./types.ts";

type AttemptStream = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream;

export interface RotatingStreamDependencies extends ClaudeStreamDependencies {
  loadAccounts?: () => ClaudeAccountRotationConfig;
  rotationState?: ClaudeAccountRotationState;
  /** Injection seam for deterministic offline tests. */
  attemptStream?: (configDir: string, onNotice: RateLimitNoticeSink) => AttemptStream;
  /** Injection seam for cancellation and delay tests; returns false if aborted. */
  waitBeforeRetry?: typeof waitForRotationDelay;
  onPause?: (previous: string, seconds: number, sessionId?: string) => void;
  onSwitch?: (previous: string, next: string, sessionId?: string) => void;
  /** Advisory event for the UI; names the OAuth profile attempted, not its quota. */
  onAccountAttempt?: (name: string, sessionId?: string) => void;
}

/**
 * Retry only after a structured subscription rejection, and only before the
 * stream has exposed content or tool calls. Never retry a profile twice or
 * retry a transport/auth error. The existing image-recovery budget stays inside
 * each candidate's stream.
 */
export function createRotatingClaudeStream(installation: ClaudeInstallation, dependencies: RotatingStreamDependencies = {}): AttemptStream {
  const plain = createClaudeStream(installation, dependencies);
  const load = dependencies.loadAccounts ?? loadClaudeAccountRotationConfig;
  const state = dependencies.rotationState ?? accountRotationState();
  const waitBeforeRetry = dependencies.waitBeforeRetry ?? waitForRotationDelay;

  return (model, context, options) => {
    let config: ClaudeAccountRotationConfig;
    try { config = load(); }
    catch (error) { return failedStream(model, error instanceof Error ? error.message : String(error)); }
    if (!config.enabled) {
      const selected = config.accounts.find((account) => account.name === config.selectedAccount);
      if (!selected) return plain(model, context, options);
      try { dependencies.onAccountAttempt?.(selected.name, options?.sessionId); } catch { /* Observer only. */ }
      const stream = dependencies.attemptStream?.(selected.configDir, () => {}) ??
        createClaudeStream(installation, { ...dependencies, claudeConfigDir: selected.configDir });
      return stream(model, context, options);
    }

    const outer = createAssistantMessageEventStream();
    state.selectionChanged(config.accounts, config.selectedAccount);
    const delaySeconds = config.rotationDelaySeconds ?? DEFAULT_ROTATION_DELAY_SECONDS;
    const delayMs = delaySeconds * 1000;
    // One logical request keeps one deadline across all subscription attempts.
    const configured = Number(process.env.PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS ?? 1_800_000);
    const maximum = Number.isFinite(configured) && configured > 0 ? configured : 1_800_000;
    const budget = Math.min(options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : maximum, maximum);
    const deadline = Date.now() + budget;
    void (async () => {
      const tried = new Set<string>();
      let previous: string | undefined;
      let needsPause = false;
      let lastError: Extract<AssistantMessageEvent, { type: "error" }> | undefined;
      while (true) {
        if (options?.signal?.aborted) {
          fail(outer, model, "Claude Code request was aborted", "aborted");
          return;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          fail(outer, model, "Claude Code account failover exhausted the request timeout budget");
          return;
        }
        const account = state.choose(config.accounts, tried, Date.now(), config.selectedAccount);
        if (!account) {
          const reset = state.nextReset(config.accounts);
          const detail = `Claude Code OAuth profiles exhausted (${tried.size}/${config.accounts.length} tried in this request)` +
            (reset !== undefined ? `; next quota reset at ${new Date(reset).toLocaleString()}` : "");
          if (lastError) {
            const original = lastError.error.errorMessage ?? "Claude Code rate limited";
            outer.push({ ...lastError, error: { ...lastError.error, errorMessage: `${original}; ${detail}` } });
            outer.end();
          } else fail(outer, model, detail);
          return;
        }
        if (needsPause) {
          needsPause = false;
          // A pause is useful only if another eligible profile exists.
          // Do not wait when all profiles are exhausted or on initial launch.
          if (delayMs > 0) {
            if (delayMs >= remainingMs) {
              fail(outer, model, "Claude Code account rotation pause exceeds the remaining request timeout");
              return;
            }
            try {
              if (previous !== undefined) dependencies.onPause?.(previous, delaySeconds, options?.sessionId);
            } catch { /* Observer only. */ }
            const completed = await waitBeforeRetry(delayMs, options?.signal);
            if (!completed || options?.signal?.aborted) {
              fail(outer, model, "Claude Code request was aborted during account rotation pause", "aborted");
              return;
            }
            // Concurrent requests may have exhausted the selected candidate
            // during the pause. Re-evaluate availability before launching.
            continue;
          }
        }
        const attemptBudgetMs = deadline - Date.now();
        if (attemptBudgetMs <= 0) {
          fail(outer, model, "Claude Code account failover exhausted the request timeout budget");
          return;
        }
        tried.add(account.configDir);
        if (previous) {
          try { dependencies.onSwitch?.(previous, account.name, options?.sessionId); } catch { /* Observer only. */ }
        }
        try { dependencies.onAccountAttempt?.(account.name, options?.sessionId); } catch { /* Observer only. */ }
        previous = account.name;
        let rejected: RateLimitNotice | undefined;
        const onNotice: RateLimitNoticeSink = (notice) => {
          if (notice.status === "rejected" && (notice.rateLimitType === "five_hour" || notice.rateLimitType === "seven_day")) {
            rejected = notice;
          }
        };
        const attempt = dependencies.attemptStream?.(account.configDir, onNotice) ?? createClaudeStream(installation, {
          ...dependencies,
          claudeConfigDir: account.configDir,
          onAccountRateLimitNotice: onNotice,
        });
        let pendingStart: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
        let publishedContent = false;
        let retry = false;
        const flushStart = () => {
          if (pendingStart) outer.push(pendingStart);
          pendingStart = undefined;
        };
        for await (const event of attempt(model, context, { ...options, timeoutMs: attemptBudgetMs })) {
          if (event.type === "start") {
            pendingStart = event;
            continue;
          }
          if (event.type === "error") {
            if (rejected && !publishedContent && !options?.signal?.aborted && event.reason === "error") {
              state.reject(config.accounts, account, rejected);
              lastError = event;
              retry = true;
              needsPause = true;
              break;
            }
            flushStart();
            outer.push(event);
            outer.end();
            return;
          }
          if (event.type !== "done") publishedContent = true;
          flushStart();
          outer.push(event);
          if (event.type === "done") {
            outer.end();
            return;
          }
        }
        if (!retry) {
          fail(outer, model, "Claude Code stream ended without a terminal result");
          return;
        }
      }
    })().catch((error: unknown) => {
      fail(outer, model, error instanceof Error ? error.message : String(error));
    });
    return outer;
  };
}

function fail(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  message: string,
  reason: "error" | "aborted" = "error",
): void {
  const output = createOutput(model);
  output.stopReason = reason;
  output.errorMessage = message;
  stream.push({ type: "error", reason, error: output });
  stream.end();
}

function failedStream(model: Model<Api>, message: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  fail(stream, model, message);
  return stream;
}
