import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { watchFile, unwatchFile } from "node:fs";
import { semanticConfigurationPath } from "./native-embedding-provider.mjs";
import { SessionChunkSync } from "./session-chunk-sync.mjs";
import { indexSessionChunks } from "./session-chunks.mjs";
import { SESSION_CHUNK_FORMAT } from "./session-chunk-store.mjs";
import type { TranscriptCandidate } from "./session-transcript.mjs";
import { commitIdentity } from "./semantic-commit-provider.js";
import { semanticConfiguration, semanticKey, requireSemanticIdentity, embedTaskTexts, type SemanticSearchOptions } from "./semantic-provider.js";
import { withProviderSlot, automaticWorkPaused, SearchWorkNeedsContinueError } from "./source-work.mjs";
import { classifyIndexFailure, logBackgroundIndexFailure, logSearchDiagnostic } from "./search-logging.mjs";
import { suiteDiagnostics } from "../lib/suite-diagnostics.js";
import { SessionIdlePolicy, IdleSessionSelection } from "./session-idle.mjs";
import { indexMissingSessionVectors } from "./semantic-session-indexer.js";
import { SessionCandidateCatalog, readSessionTitle } from "./session-discovery.mjs";
import { beginSessionSweep, completeSessionSweep } from "./session-watermark.mjs";

export async function syncSessionChunks(root: string,candidates: readonly TranscriptCandidate[],signal: AbortSignal,
  options: SemanticSearchOptions = {},drain = false,retry = drain,
  eligible?: (candidate: TranscriptCandidate, signal: AbortSignal) => Promise<boolean>) {
  const config = await semanticConfiguration(options,signal);
  const key = config?.provider === "openrouter" ? await semanticKey(options,signal) : undefined;
  const embedding = config && (key || config.provider === "ollama") ? {
    identity:commitIdentity(config),dimension:config.dimension,
    authorized: async (owned: AbortSignal) => {
      await requireSourceEnabled(root, "sessions", owned);
      await requireSemanticIdentity(options,config,owned);
      return config.provider === "ollama" || Boolean(await semanticKey(options,owned));
    },
    embed: async (texts: string[],owned: AbortSignal,beforeSend?: () => Promise<void>) => (await withProviderSlot(owned,async ()=> {
      await beforeSend?.();
      return (options.embedTasks ?? embedTaskTexts)(texts,key,owned,config);
    })).map(v=>[...v]),
  } : undefined;
  return indexSessionChunks(root,candidates,{signal,...(embedding?{embedding}:{}),drain,retry,...(eligible?{eligible}:{})});
}

export function registerSessionChunkSync(pi: ExtensionAPI,options: SemanticSearchOptions = {}): void {
  let active: {owner: AbortController;sync: SessionChunkSync;policy: SessionIdlePolicy;unwatch(): void} | undefined;
  let generation = 0;
  const stop = async () => {
    const old = active; active = undefined;
    if(old) { old.owner.abort();old.unwatch();await Promise.all([old.sync.dispose(),old.policy.dispose()]); }
  };
  const start = async (ctx: ExtensionContext) => {
    const revision = ++generation;
    const old = active;
    old?.owner.abort(); old?.unwatch();
    const root = resolve(ctx.cwd),owner = new AbortController();
    const policy = new SessionIdlePolicy(root), selection = new IdleSessionSelection(policy);
    const catalog = new SessionCandidateCatalog();
    const eligible = (candidate: TranscriptCandidate, signal: AbortSignal) => policy.eligible(candidate,signal);
    let phase = "policy";
    const sync = new SessionChunkSync(signal=>withSourcePolicy(root,signal,async signal=>{
      phase = "policy";
      if (!await sourceEnabled(root,"sessions")) return;
      if (await automaticWorkPaused(root,"sessions",signal)) { selection.reset(); return; }
      phase = "embedding";
      const config = await semanticConfiguration(options,signal);
      const key = config?.provider === "openrouter" ? await semanticKey(options,signal) : undefined;
      if (config?.provider === "openrouter" && !key) return;
      const identity = `${SESSION_CHUNK_FORMAT}:${config ? commitIdentity(config) : "lexical-only"}`;
      phase = "sweep";
      const pass = await beginSessionSweep(root,identity,signal);
      selection.useCache(`${identity}:${pass.cacheRevision}`);
      phase = "discovery";
      const candidates = await catalog.list(root,getAgentDir(),signal);
      phase = "selection";
      const selected = await selection.select(candidates,signal,pass.since);
      let complete = selection.complete;
      let failedIndexing = false;
      for (const candidate of selected) {
        try {
          if (!await eligible(candidate,signal)) { complete = false; continue; }
          if (config) {
            phase = "title";
            const title = await readSessionTitle(root,candidate,signal);
            if (!title) { complete = false; failedIndexing = true; continue; }
            const result = await indexMissingSessionVectors(root,[title],key,options,signal,config,true,eligible,false);
            if (result.remaining) { complete = false; failedIndexing = true; continue; }
          }
          phase = "indexing";
          const result = await syncSessionChunks(root,[candidate],signal,options,true,false,eligible);
          if (result.complete) selection.succeeded(candidate);
          else { complete = false; if (!result.deferred) failedIndexing = true; }
        } catch (error) {
          complete = false;
          signal.throwIfAborted();
          failedIndexing = true;
          const paused = error instanceof SearchWorkNeedsContinueError;
          suiteDiagnostics.report("warn", "search", "background-session-index-stopped", root,
            { source: "sessions", phase: paused ? "needs_continue" : "candidate_failed" });
          await logSearchDiagnostic(root,{event:"session_indexing_stopped",sessionId:candidate.id,
            reason:paused?"needs_continue":"candidate_failed",...classifyIndexFailure(error),
            message:"Session indexing stopped; local search remains available."});
          if (paused) { selection.reset(); break; }
        }
      }
      signal.throwIfAborted();
      if (failedIndexing) sync.noteIncomplete();
      phase = "finalize";
      if (config) await requireSemanticIdentity(options,config,signal);
      else if (await semanticConfiguration(options,signal)) { selection.reset(); return; }
      await requireSourceEnabled(root,"sessions",signal);
      if (complete) await completeSessionSweep(root,pass,signal);
      const after = await beginSessionSweep(root,identity,signal);
      if (pass.incarnation && after.incarnation !== pass.incarnation) selection.reset();
      selection.cacheRevision = `${identity}:${after.cacheRevision}`;
    }),owner.signal,error=>{logBackgroundIndexFailure(root,error,phase);});
    const changed = () => { void start(ctx).catch(()=>{}); };
    const config = semanticConfigurationPath();
    watchFile(config,{persistent:false,interval:1000},changed);
    const unwatchPolicy = watchSourcePolicy(root,changed);
    active = {owner,sync,policy,unwatch:()=>{catalog.dispose();unwatchFile(config,changed);unwatchPolicy();}};
    // Publish the new observer before awaiting persistence or old-owner teardown.
    // Activity arriving during either wait must synchronously fence this policy.
    try {
      await Promise.all([
        policy.observe(ctx.sessionManager.getSessionId(), !ctx.isIdle(), !ctx.isIdle()),
        ...(old ? [old.sync.dispose(), old.policy.dispose()] : []),
      ]);
    } finally {
      // Keep polling after a transient persistence failure; eligibility fails closed.
      if (revision === generation) sync.changed();
    }
  };
  pi.on("session_start",async (_event,ctx)=>{await start(ctx);});
  const activity = async (ctx: ExtensionContext, running = !ctx.isIdle()) => {
    const current = active;
    if (!current) return;
    await current.policy.observe(ctx.sessionManager.getSessionId(),running);
    current.sync.changed();
  };
  pi.on("agent_start",async (_event,ctx)=>{await activity(ctx,true);});
  pi.on("agent_end",async (_event,ctx)=>{await activity(ctx,false);});
  pi.on("turn_end",async (_event,ctx)=>{await activity(ctx);});
  pi.on("message_end",async (_event,ctx)=>{await activity(ctx);});
  pi.on("session_tree",async (_event,ctx)=>{await activity(ctx);});
  pi.on("session_shutdown",async ()=>{generation++;await stop();});
}
import { sourceEnabled, requireSourceEnabled, watchSourcePolicy, withSourcePolicy } from "./source-policy.mjs";
