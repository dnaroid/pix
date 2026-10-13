export function searchTokens(text: string): string[];
export function queryTerms(query: string): string[];
export function queryIdentifiers(query: string): string[];
export function preferDistinctFiles<T extends {kind: string; path?: string; id: string}>(hits: T[]): T[];
export function prioritizeIdentifiers<T extends {path?: string; title: string; content?: string; snippet: string}>(hits: T[], query: string): T[];
