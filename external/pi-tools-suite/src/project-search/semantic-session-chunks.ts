import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { watchFile, unwatchFile } from "node:fs";
import { semanticConfigurationPath } from "./native-embedding-provider.mjs";
import { SessionChunkSync } from "./session-chunk-sync.mjs";
import { indexSessionChunks } from "./session-chunks.mjs";
import type { TranscriptCandidate } from "./session-transcript.mjs";
import { commitIdentity } from "./semantic-commit-provider.js";
import { semanticConfiguration, semanticKey, requireSemanticIdentity, embedTaskTexts, type SemanticSearchOptions } from "./semantic-provider.js";
import { withProviderSlot } from "./source-work.mjs";
import { logSearchDiagnostic } from "./search-diagnostics.mjs";

export async function syncSessionChunks(root: string,candidates: readonly TranscriptCandidate[],signal: AbortSignal,
  options: SemanticSearchOptions = {},drain = false,retry = drain) {
  const config = await semanticConfiguration(options,signal);
  const key = config?.provider === "openrouter" ? await semanticKey(options,signal) : undefined;
  const embedding = config && (key || config.provider === "ollama") ? {
    identity:commitIdentity(config),dimension:config.dimension,
    authorized: async (owned: AbortSignal) => {
      await requireSemanticIdentity(options,config,owned);
      return config.provider === "ollama" || Boolean(await semanticKey(options,owned));
    },
    embed: async (texts: string[],owned: AbortSignal) => (await withProviderSlot(owned,()=>
      (options.embedTasks ?? embedTaskTexts)(texts,key,owned,config))).map(v=>[...v]),
  } : undefined;
  return indexSessionChunks(root,candidates,{signal,...(embedding?{embedding}:{}),drain,retry});
}

export function registerSessionChunkSync(pi: ExtensionAPI,options: SemanticSearchOptions = {}): void {
  let active: {owner: AbortController;sync: SessionChunkSync;unwatch(): void} | undefined;
  let generation = 0;
  const stop = async () => {
    const old = active; active = undefined;
    if(old) { old.owner.abort();old.unwatch();await old.sync.dispose(); }
  };
  const start = async (ctx: ExtensionContext) => {
    const revision = ++generation;
    await stop();
    if(revision !== generation) return;
    const root = resolve(ctx.cwd),owner = new AbortController();
    const sync = new SessionChunkSync(async signal=>{
      const candidates = (await SessionManager.list(root,undefined,undefined,signal)).filter(s=>resolve(s.cwd)===root);
      await syncSessionChunks(root,candidates,signal,options,true,false);
    },owner.signal,()=>{void logSearchDiagnostic(root,{event:"session_indexing_stopped",message:"Session indexing stopped; local search remains available."});});
    const changed = () => { void start(ctx).catch(()=>{}); };
    const config = semanticConfigurationPath();
    watchFile(config,{persistent:false,interval:1000},changed);
    active = {owner,sync,unwatch:()=>unwatchFile(config,changed)};
    sync.changed();
  };
  pi.on("session_start",async (_event,ctx)=>{await start(ctx);});
  pi.on("turn_end",async ()=>{active?.sync.changed();});
  pi.on("message_end",async event=>{
    if(event.message.role==="user" || event.message.role==="assistant") active?.sync.changed();
  });
  pi.on("session_tree",async ()=>{active?.sync.changed();});
  pi.on("session_shutdown",async ()=>{generation++;await stop();});
}
