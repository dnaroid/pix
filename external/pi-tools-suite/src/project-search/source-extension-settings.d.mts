export const codeDefaults: string[];
export const knowledgeDefaults: string[];
export class SourceExtensionConfigurationError extends Error {}
export function resolveSourceExtensions(search?: { codeExtensions?: unknown; knowledgeExtensions?: unknown }): {
  code: Set<string>; knowledge: Set<string>; signature: string;
};
