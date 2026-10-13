import type { SessionMapRecord } from "../acp/session-map.js";
import { SessionChunkSync } from "./session-chunk-sync.js";
import { indexSessionChunks, searchSessionChunks, type ChunkEmbedding } from "./session-chunks.js";
import { semanticEmbeddingIdentity, type SemanticEmbeddingConfig } from "./config.js";
import type { SessionSearchHit } from "./contract.js";
import { logSearchDiagnostic } from "./search-diagnostics.js";

export const transcriptCandidates = (records: readonly SessionMapRecord[]) => records.map(r => ({ id:r.piSessionId,path:r.piSessionPath }));
export class DesktopSessionChunks {
  private readonly owner = new AbortController();
  private readonly sync: SessionChunkSync;
  constructor(private readonly cwd: string, private readonly options: {
    signal: AbortSignal;
    discover(signal: AbortSignal): Promise<readonly SessionMapRecord[]>;
    embedding(signal: AbortSignal): Promise<ChunkEmbedding | undefined>;
    failed(error: unknown): void;
  }) {
    const signal = AbortSignal.any([this.owner.signal,options.signal]);
    this.sync = new SessionChunkSync(async owned => {
      const result = await this.index(owned, false, true);
      if(!result.complete) options.failed(new Error("Some session transcripts could not be indexed; local results may be incomplete"));
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
