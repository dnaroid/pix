export type CoverageSource = "settings" | "sessions" | "tasks" | "commits";
export const COVERAGE_KEEP: Readonly<Record<CoverageSource, number>>;
export function coverageIdentity(config: { provider: string; model: string; dimension: number; queryPrefix: string; documentPrefix: string; baseUrl: string } | undefined | null): string | null;
export function coverageDigest(source: CoverageSource, revision: unknown, identity: string | null | undefined): string;
export function settingsCatalogueDigest(settings: readonly { id: string; section: string; label: string; description?: string | undefined; synonyms: readonly string[] }[]): string;
export function recordCoverage(db: { exec(sql: string): unknown; prepare(sql: string): any }, digest: string, keep: number, now?: number): void;
export function readCoverage(filename: string, signal?: AbortSignal): Promise<Set<string> | undefined>;
