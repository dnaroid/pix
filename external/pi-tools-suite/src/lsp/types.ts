import type { LspServerConfig } from "./_shared/types";

export interface MatchedServer {
  server: LspServerConfig;
  root: string;
  relFile: string;
}

export interface OpenDocument {
  file: string;
  uri: string;
  languageId: string;
  version: number;
  text: string;
}
