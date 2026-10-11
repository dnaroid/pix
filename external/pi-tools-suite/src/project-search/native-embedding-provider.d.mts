export interface RepositoryEmbeddingConfig {
  provider: "openrouter" | "ollama";
  model: string;
  dimension: number;
  queryPrefix: string;
  documentPrefix: string;
  baseUrl: string;
  identity: string;
}
export interface RepositoryEmbeddingSettings {
  signature: string;
  enabled: boolean;
  configs: Record<"code" | "knowledge", RepositoryEmbeddingConfig>;
}
export function digest(text: string): string;
export function regularText(file: string, max?: number): Promise<string>;
export function semanticConfigurationPath(): string;
export function semanticConfigurationText(file?: string): Promise<string>;
export function parseSemanticConfiguration(text: string): Record<string, unknown>;
export function parseEmbeddingSettings(text: string): RepositoryEmbeddingSettings | undefined;
export function repositoryEmbeddingSettings(root?: string, requireConsent?: boolean, file?: string): Promise<RepositoryEmbeddingSettings | undefined>;
export function repositoryEmbeddingKey(): Promise<string | undefined>;
export function validVector(vector: unknown, dimension: number): vector is number[];
export function embedRepository(inputs: string[], config: RepositoryEmbeddingConfig, key: string | undefined, signal: AbortSignal): Promise<number[][]>;
