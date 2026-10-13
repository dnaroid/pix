interface ResolvedToolName {
  name: string;
  normalized: boolean;
}

/** Resolve only names proved by this request's catalog, never guessed aliases. */
export function resolveToolName(proposed: string, registered: ReadonlyMap<string, string>): ResolvedToolName | undefined {
  const exact = registered.get(proposed);
  if (exact !== undefined) return { name: exact, normalized: false };

  // Match the serializer's unchanged-name range. Qualified/foreign namespaces
  // and hashed or collision aliases are not bare Pi names for this fallback.
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(proposed) || proposed.startsWith("mcp__")) return undefined;
  if (registered.get(`mcp__pi__${proposed}`) !== proposed) return undefined;
  let matches = 0;
  for (const name of registered.values()) {
    if (name === proposed && ++matches > 1) return undefined;
  }
  return { name: proposed, normalized: true };
}
