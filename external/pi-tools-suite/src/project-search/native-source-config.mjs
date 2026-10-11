import path from "node:path";
import { parseSemanticConfiguration, semanticConfigurationText } from "./native-embedding-provider.mjs";

import { resolveSourceExtensions, SourceExtensionConfigurationError } from "./source-extension-settings.mjs";
export { SourceExtensionConfigurationError } from "./source-extension-settings.mjs";

export function parseSourceExtensions(text) {
  let search;
  try { search = parseSemanticConfiguration(text).search ?? {}; }
  catch { throw new SourceExtensionConfigurationError("Cannot read source extensions: invalid suite JSONC settings."); }
  return resolveSourceExtensions(search);
}

export async function readSourceExtensions() {
  let text;
  try { text = await semanticConfigurationText(); }
  catch { throw new SourceExtensionConfigurationError("Cannot read source extensions: suite settings are unavailable or unsafe."); }
  return parseSourceExtensions(text);
}

export function sourceKind(name, extensions) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (extensions.knowledge.has(ext)) return "knowledge";
  if (extensions.code.has(ext)) return "code";
}
