import type { SessionMapRecord } from "../acp/session-map.js";
import { SessionChunkSync } from "./session-chunk-sync.js";
import { indexSessionChunks, searchSessionChunks, listIndexedSessions, type ChunkEmbedding } from "./session-chunks.js";
import { SESSION_CHUNK_FORMAT } from "./session-chunk-store.js";
import { semanticEmbeddingIdentity, type SemanticEmbeddingConfig } from "./config.js";
import type { SessionSearchHit } from "./contract.js";
import { classifyIndexFailure, isExpectedIndexCancellation, logBackgroundIndexFailure, logSearchDiagnostic } from "./search-logging.js";
import { SessionIdlePolicy, IdleSessionSelection } from "./session-idle.js";
import { automaticWorkPaused, SearchWorkNeedsContinueError } from "./source-work.js";
import type { BackgroundSessionRecord } from "./background-session-discovery.js";
import { beginSessionSweep, completeSessionSweep } from "./session-watermark.js";
import { coverageDigest } from "./source-coverage.js";

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
    /** Logical session snapshot observed by the native probe; enables coverage evidence. */
    snapshot?(signal: AbortSignal): Promise<string>;
    titles(record: BackgroundSessionRecord, signal: AbortSignal): Promise<void>;
    failed(error: unknown): void;
    /** A later background pass finished without indexing failures. */
    recovered?(): void;
  }) {
    const signal = AbortSignal.any([this.owner.signal,options.signal]);
    const selection = new IdleSessionSelection(options.policy);
    let phase = "policy";
    this.sync = new SessionChunkSync(async owned => {
      phase = "policy";
      if (await automaticWorkPaused(cwd,"sessions",owned)) { selection.reset(); return; }
      phase = "embedding";
      const embedding = await options.embedding(owned);
      const identity = `${SESSION_CHUNK_FORMAT}:${embedding?.identity ?? "lexical-only"}`;
      phase = "sweep";
      const snapshotBefore = await options.snapshot?.(owned).catch(() => undefined);
      const pass = await beginSessionSweep(cwd,identity,owned);
      selection.useCache(`${identity}:${pass.cacheRevision}`);
      phase = "discovery";
      const records = await options.discoverBackground(owned);
      phase = "selection";
      const candidates = await selection.select(records.map(r => ({id:r.piSessionId,path:r.piSessionPath,
        createdAt:r.createdAt,changedAt:Date.parse(r.updatedAt)||0})),owned,pass.since);
      let complete = selection.complete;
      let failedIndexing = false;
      for (const candidate of candidates) {
        try {
          if (!await options.policy.eligible(candidate,owned)) { complete = false; continue; }
          const record = records.find(r => r.piSessionId === candidate.id && r.piSessionPath === candidate.path)!;
          phase = "title";
          await options.titles(record,owned);
          phase = "indexing";
          const result = await indexSessionChunks(cwd,[candidate],{signal:owned,...(embedding?{embedding}:{}),drain:true,
            eligible:(item,current)=>options.policy.eligible(item,current)});
          if (result.complete) selection.succeeded(candidate);
          else complete = false;
          if(!result.complete && !result.deferred) {
            failedIndexing = true;
            options.failed(new Error("Some session transcripts could not be indexed; local results may be incomplete"));
          }
        } catch (error) {
          complete = false;
          owned.throwIfAborted();
          failedIndexing = true;
          options.failed(error);
          const paused = error instanceof SearchWorkNeedsContinueError;
          await logSearchDiagnostic(cwd,{event:"session_indexing_stopped",sessionId:candidate.id,
            reason:paused?"needs_continue":"candidate_failed",...classifyIndexFailure(error),
            message:"Session indexing incomplete or unavailable; local search remains available."});
          if (paused) { selection.reset(); break; }
        }
      }
      owned.throwIfAborted();
      if (failedIndexing) this.sync.noteIncomplete();
      phase = "finalize";
      if ((await options.embedding(owned))?.identity !== embedding?.identity) { selection.reset(); return; }
      if (embedding && !await embedding.authorized(owned)) { selection.reset(); return; }
      if (complete) {
        // Coverage only when the observed snapshot held for the whole complete pass.
        const stable = snapshotBefore !== undefined && await options.snapshot?.(owned).catch(() => undefined) === snapshotBefore;
        await completeSessionSweep(cwd,pass,owned,Date.now,
          stable ? coverageDigest("sessions",snapshotBefore,embedding?.identity ?? null) : undefined);
      }
      const after = await beginSessionSweep(cwd,identity,owned);
      if (pass.incarnation && after.incarnation !== pass.incarnation) selection.reset();
      selection.cacheRevision = `${identity}:${after.cacheRevision}`;
      if (!failedIndexing && !selection.hasUnresolvedFailures()) options.recovered?.();
    },signal,error => {
      if (isExpectedIndexCancellation(error)) return;
      logBackgroundIndexFailure(cwd,error,phase);
      options.failed(error);
    });
  }
  get indexing(): boolean { return Boolean(this.sync.worker); }
  changed(): void { this.sync.changed(); }
  async index(signal: AbortSignal, retry = false, drain = retry, snapshot?: readonly SessionMapRecord[]) {
    const owned = AbortSignal.any([signal,this.owner.signal,this.options.signal]);
    const records = snapshot ?? await this.options.discover(owned);
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
/** Mapping is metadata-only; never call SDK transcript discovery on a query. */
export async function indexedSessionRecords(cwd: string,signal: AbortSignal,saved: readonly SessionMapRecord[] = []): Promise<(SessionMapRecord & { indexRevision: string })[]> {
  const byPath = new Map(saved.map(record=>[record.piSessionPath,record]));
  return (await listIndexedSessions(cwd,signal)).map(row=>{
    const mapped = byPath.get(row.path);
    return { sessionId:mapped?.piSessionId===row.id ? mapped.sessionId : row.id,
      piSessionId:row.id,piSessionPath:row.path,cwd:row.cwd,title:row.title,indexRevision:`${row.revision}:${row.fileStamp}`,
      namedTitle:row.name && (!mapped || (mapped.piSessionId===row.id && mapped.title?.trim()===row.name && mapped.namedTitle?.trim()===row.name))
        ? row.name : undefined,updatedAt:mapped?.updatedAt ?? "" };
  });
}
