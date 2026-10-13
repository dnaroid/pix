import type { SessionMapRecord } from "../acp/session-map.js";
import { SessionChunkSync } from "./session-chunk-sync.js";
import { indexSessionChunks, searchSessionChunks, type ChunkEmbedding } from "./session-chunks.js";
import { semanticEmbeddingIdentity, type SemanticEmbeddingConfig } from "./config.js";
import type { SessionSearchHit } from "./contract.js";
import { logSearchDiagnostic } from "./search-diagnostics.js";
import { SessionIdlePolicy, IdleSessionSelection } from "./session-idle.js";
import { automaticWorkPaused, SearchWorkNeedsContinueError } from "./source-work.js";
import type { BackgroundSessionRecord } from "./background-session-discovery.js";
import { beginSessionSweep, completeSessionSweep } from "./session-watermark.js";

export const transcriptCandidates = (records: readonly SessionMapRecord[]) => records.map(r => ({ id:r.piSessionId,path:r.piSessionPath }));
export class DesktopSessionChunks {
  private readonly owner = new AbortController();
  private readonly sync: SessionChunkSync;
  constructor(private readonly cwd: string, private readonly options: {
    signal: AbortSignal;
    discover(signal: AbortSignal): Promise<readonly SessionMapRecord[]>;
    discoverBackground(signal: AbortSignal): Promise<readonly BackgroundSessionRecord[]>;
    embedding(signal: AbortSignal): Promise<ChunkEmbedding | undefined>;
    policy: SessionIdlePolicy;
    titles(record: BackgroundSessionRecord, signal: AbortSignal): Promise<void>;
    failed(error: unknown): void;
  }) {
    const signal = AbortSignal.any([this.owner.signal,options.signal]);
    const selection = new IdleSessionSelection(options.policy);
    this.sync = new SessionChunkSync(async owned => {
      if (await automaticWorkPaused(cwd,"sessions",owned)) { selection.reset(); return; }
      const embedding = await options.embedding(owned);
      const identity = embedding?.identity ?? "lexical-only";
      const pass = await beginSessionSweep(cwd,identity,owned);
      selection.useCache(`${identity}:${pass.cacheRevision}`);
      const records = await options.discoverBackground(owned);
      const candidates = await selection.select(records.map(r => ({id:r.piSessionId,path:r.piSessionPath,
        createdAt:r.createdAt,changedAt:Date.parse(r.updatedAt)||0})),owned,pass.since);
      let complete = selection.complete;
      for (const candidate of candidates) {
        try {
          if (!await options.policy.eligible(candidate,owned)) { complete = false; continue; }
          const record = records.find(r => r.piSessionId === candidate.id && r.piSessionPath === candidate.path)!;
          await options.titles(record,owned);
          const result = await indexSessionChunks(cwd,[candidate],{signal:owned,...(embedding?{embedding}:{}),drain:true,
            eligible:(item,current)=>options.policy.eligible(item,current)});
          if (result.complete) selection.succeeded(candidate);
          else complete = false;
          if(!result.complete && !result.deferred) options.failed(new Error("Some session transcripts could not be indexed; local results may be incomplete"));
        } catch (error) {
          complete = false;
          owned.throwIfAborted();
          options.failed(error);
          const paused = error instanceof SearchWorkNeedsContinueError;
          await logSearchDiagnostic(cwd,{event:"session_indexing_stopped",sessionId:candidate.id,
            reason:paused?"needs_continue":"candidate_failed",message:"Session indexing incomplete or unavailable; local search remains available."});
          if (paused) { selection.reset(); break; }
        }
      }
      owned.throwIfAborted();
      if ((await options.embedding(owned))?.identity !== embedding?.identity) { selection.reset(); return; }
      if (embedding && !await embedding.authorized(owned)) { selection.reset(); return; }
      if (complete) await completeSessionSweep(cwd,pass,owned);
      const after = await beginSessionSweep(cwd,identity,owned);
      if (pass.incarnation && after.incarnation !== pass.incarnation) selection.reset();
      selection.cacheRevision = `${identity}:${after.cacheRevision}`;
    },signal,error => {
      void logSearchDiagnostic(cwd,{event:"session_indexing_stopped",message:"Session indexing incomplete or unavailable; local search remains available."});
      options.failed(error);
    });
  }
  get indexing(): boolean { return Boolean(this.sync.worker); }
  changed(): void { this.sync.changed(); }
  async index(signal: AbortSignal, retry = false, drain = retry) {
    const owned = AbortSignal.any([signal,this.owner.signal,this.options.signal]);
    const records = await this.options.discover(owned);
    const embedding = await this.options.embedding(owned);
    return indexSessionChunks(this.cwd,transcriptCandidates(records),{signal:owned,...(embedding?{embedding}:{}),retry,drain});
  }
  async dispose(): Promise<void> { this.owner.abort(); await this.sync.dispose(); }
}
export async function sessionChunkHits(cwd: string,records: readonly SessionMapRecord[],query: string,signal: AbortSignal,
  config?: SemanticEmbeddingConfig,queryVector?: number[]): Promise<SessionSearchHit[]> {
  const byId = new Map(records.map(r=>[r.piSessionId,r]));
  return (await searchSessionChunks(cwd,transcriptCandidates(records),query,signal,config && queryVector
    ? {identity:semanticEmbeddingIdentity(config),dimension:config.dimension,query:queryVector}:undefined)).flatMap(hit=>{
      const record = byId.get(hit.id);
      return record ? [{...hit,kind:"sessions" as const,id:`sessions:${record.sessionId}`,sessionId:record.sessionId,
        title:record.title?.trim() || record.piSessionId,
        messageId:hit.messageId,boundaryMatch:true}] : [];
    });
}
