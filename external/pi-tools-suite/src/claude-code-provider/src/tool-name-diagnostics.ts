import { createHash } from "node:crypto";
import type { ToolNameMismatch } from "./types.ts";

const SAFE_NAME = /^[A-Za-z0-9_-]{1,80}$/;

/** Record enough to distinguish a missing MCP qualifier from catalog drift. */
export function diagnoseToolNameMismatch(name: string, registered: ReadonlyMap<string, string>): ToolNameMismatch {
  const expected = [...registered].find(([, piName]) => piName === name)?.[0];
  const fingerprint = createHash("sha256")
    .update([...registered.keys()].sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
  return {
    // Only persist names already present in Pi's active catalog. Arbitrary
    // unknown strings could contain credentials even when syntactically valid.
    proposedName: !SAFE_NAME.test(name) ? "<noncanonical>" : expected ? name : "<unrecognized>",
    classification: expected ? "unqualified_active" : name.startsWith("mcp__pi__") ? "unknown_qualified" : "unrecognized",
    ...(expected && SAFE_NAME.test(expected) ? { expectedTransportName: expected } : {}),
    catalogSize: registered.size,
    catalogFingerprint: fingerprint,
    // startBlock is reachable only after a validated system.init.
    initializationValidated: true,
  };
}
