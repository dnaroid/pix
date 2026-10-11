export const codeDefaults = "ts tsx mts cts js jsx mjs cjs py rs go java kt kts swift c h cpp hpp cc cs rb php sh bash zsh fish vue svelte css scss sass less html xml sql lua ex exs erl clj cljs scala dart r toml yaml yml json jsonc ini cfg proto graphql gql cmake make asm s pl pm diff patch gd tscn tres godot gdshader gdshaderinc".split(" ");
export const knowledgeDefaults = ["md", "mdx", "markdown", "rst", "txt", "adoc"];

export class SourceExtensionConfigurationError extends Error {}

function extensions(value, key, defaults) {
  if (value === undefined) return new Set(defaults);
  if (!Array.isArray(value) || value.length > 128 || value.some(item =>
    typeof item !== "string" || !/^\.?[a-z0-9][a-z0-9_+-]{0,31}(?![\s\S])/i.test(item))) {
    throw new SourceExtensionConfigurationError(`Invalid search.${key}: expected at most 128 simple extensions (with or without a leading dot); paths and globs are not allowed.`);
  }
  return new Set(value.map(item => item.replace(/^\./, "").toLowerCase()));
}

export function resolveSourceExtensions(search = {}) {
  const code = extensions(search.codeExtensions, "codeExtensions", codeDefaults);
  const knowledge = extensions(search.knowledgeExtensions, "knowledgeExtensions", knowledgeDefaults);
  if ([...code].some(extension => knowledge.has(extension))) {
    throw new SourceExtensionConfigurationError("search.codeExtensions and search.knowledgeExtensions overlap. Assign each extension to only one source.");
  }
  return { code, knowledge, signature: JSON.stringify([[...code].sort(), [...knowledge].sort()]) };
}

