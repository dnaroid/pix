// Exercise the adapter's optional-import fallback without breaking the installed
// SDK, which itself still imports compat. This is not an SDK-without-compat test.
export const UNRESOLVABLE_SPECIFIERS = ["@earendil-works/pi-ai/compat"];

export function resolve(specifier, context, nextResolve) {
  const fromAdapter = context.parentURL?.includes("/src/claude-code-provider/") ||
    context.parentURL?.includes("/support/extension-without-compat.js");
  if (fromAdapter && UNRESOLVABLE_SPECIFIERS.includes(specifier)) {
    throw new Error(`Cannot find module '${specifier}' (mapped as deleted by unresolve-compat-hooks.js)`);
  }
  return nextResolve(specifier, context);
}
