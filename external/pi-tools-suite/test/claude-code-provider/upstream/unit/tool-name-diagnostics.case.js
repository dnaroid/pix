import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseToolNameMismatch } from "../../../../src/claude-code-provider/src/tool-name-diagnostics.ts";

test("unknown qualified names are distinguishable without exposing the catalog", () => {
    const names = new Map([["mcp__pi__Edit", "Edit"], ["mcp__pi__Read", "Read"]]);
    const qualified = diagnoseToolNameMismatch("mcp__pi__Write", names);
    assert.equal(qualified.classification, "unknown_qualified");
    assert.equal(qualified.proposedName, "<unrecognized>");
    assert.equal(qualified.expectedTransportName, undefined);
    assert.equal(qualified.catalogSize, 2);
    assert.match(qualified.catalogFingerprint, /^[a-f0-9]{16}$/);
    assert.deepEqual(diagnoseToolNameMismatch("Edit", names), {
        proposedName: "Edit", classification: "unqualified_active", expectedTransportName: "mcp__pi__Edit",
        catalogSize: 2, catalogFingerprint: qualified.catalogFingerprint, initializationValidated: true,
    });
});

test("tool-name diagnostics never persist source paths or payloads", () => {
    const sensitive = "/private/tmp/user-secret/file.txt\nignored";
    const diagnostic = diagnoseToolNameMismatch(sensitive, new Map([["mcp__pi__Edit", "Edit"]]));
    assert.equal(diagnostic.proposedName, "<noncanonical>");
    assert.equal(diagnostic.classification, "unrecognized");
    const serialized = JSON.stringify({ toolNameMismatch: diagnostic, adapterSource: "pi-tools-suite-vendored" });
    assert.doesNotMatch(serialized, /private|user-secret|file\.txt|ignored/);
    const plausibleSecret = "ANOTHTESTTOKENTHATISVALIDASATOOLNAME";
    assert.equal(diagnoseToolNameMismatch(plausibleSecret, new Map([["mcp__pi__Edit", "Edit"]])).proposedName, "<unrecognized>");
});
