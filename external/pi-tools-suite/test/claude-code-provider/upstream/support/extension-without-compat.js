/**
 * Load the extension with its optional compat import unavailable. The installed
 * SDK's own imports remain resolvable; this isolates the adapter fallback.
 * It runs as a child because the loader mapping is process-wide: the ordinary
 * test process has pi-ai installed with its compat entrypoint, and one test
 * cannot unmap it for itself.
 *
 * The test import and adapter import both reject; the extension must still
 * register without its optional compatibility registration.
 *
 * Prints `ok` when the provider registered anyway. The parent supplies a fake
 * Claude through PI_CLAUDE_CODE_PROVIDER_PATH.
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./unresolve-compat-hooks.js", import.meta.url), { parentURL: import.meta.url });

await assert.rejects(import("@earendil-works/pi-ai/compat"), "the subpath must be unresolvable for this to prove anything");

const { default: piClaudeCodeProvider } = await import("../../../../src/claude-code-provider/extensions/index.ts");
const providers = new Map();
await piClaudeCodeProvider({
  registerCommand() {},
  registerProvider(name, config) { providers.set(name, config); },
  registerTool() {},
  on() {},
  getAllTools() { return []; },
});

assert.equal(typeof providers.get("pi-claude-code-provider")?.streamSimple, "function");
process.stdout.write("ok\n");
