import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { resolveToolName } from "../../../../src/claude-code-provider/src/tool-name-resolution.ts";
import { ClaudeEventMapper } from "../../../../src/claude-code-provider/src/stream-events.ts";
import { createOutput } from "../../../../src/claude-code-provider/src/output.ts";
import { PROVIDER_INIT_FIELDS, initRecord, toolUseEvents } from "../support/claude-fixture.js";

const model = { id: "sonnet", api: "pi-claude-code-provider-headless", provider: "pi-claude-code-provider" };
const names = new Map([["mcp__pi__Bash", "Bash"], ["mcp__pi__Edit", "Edit"]]);

test("exact catalog lookup precedes bare-name compatibility", () => {
    for (const name of ["Bash", "Edit", "read", "custom_tool-2", "x".repeat(48)]) {
        const catalog = new Map([[`mcp__pi__${name}`, name]]);
        assert.deepEqual(resolveToolName(`mcp__pi__${name}`, catalog), { name, normalized: false });
        assert.deepEqual(resolveToolName(name, catalog), { name, normalized: true });
    }
    const overlap = new Map([["mcp__pi__Bash", "Bash"], ["mcp__pi__mcp__pi__Bash", "mcp__pi__Bash"]]);
    assert.deepEqual(resolveToolName("mcp__pi__Bash", overlap), { name: "Bash", normalized: false });
});

const rejected = [
    ["inactive", "Read", names],
    ["case", "bash", names],
    ["foreign namespace", "mcp__other__Bash", names],
    ["unknown qualified", "mcp__pi__Read", names],
    ["empty", "", names],
    ["unsafe", "Bash/path", new Map([["mcp__pi__tool_digest", "Bash/path"]])],
    ["hashed alias", "tool_digest", new Map([["mcp__pi__tool_digest", "Bash/path"]])],
    ["long original", "x".repeat(49), new Map([["mcp__pi__tool_digest", "x".repeat(49)]])],
    ["collision alias", "Bash_1", new Map([["mcp__pi__Bash_1", "Bash"]])],
    ["renamed original", "Bash", new Map([["mcp__pi__Bash_1", "Bash"]])],
    ["ambiguous", "Bash", new Map([...names, ["mcp__pi__Bash_1", "Bash"]])],
    ["namespaced original", "mcp__other__Bash", new Map([["mcp__pi__mcp__other__Bash", "mcp__other__Bash"]])],
];

function mapperFor(catalog = names) {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    let handoffs = 0;
    const mapper = new ClaudeEventMapper({ stream, output, expectedTools: new Set(catalog.keys()), toolNames: catalog, onToolUse: () => handoffs++ });
    mapper.accept(initRecord(PROVIDER_INIT_FIELDS, { tools: [...catalog.keys()], mcp_servers: [{ name: "pi", status: "connected" }] }));
    return { mapper, stream, output, handoffs: () => handoffs };
}

for (const [label, proposed, catalog] of rejected) {
    test(`rejects ${label} without starting a Pi call`, () => {
        assert.equal(resolveToolName(proposed, catalog), undefined);
        const { mapper, output, handoffs } = mapperFor(catalog);
        assert.throws(() => {
            for (const event of toolUseEvents({ messageId: "msg", toolUseId: "id", name: proposed })) mapper.accept(event);
        }, /unknown tool/);
        assert.deepEqual(output.content, []);
        assert.equal(mapper.toolNameNormalizationCount, 0);
        assert.equal(handoffs(), 0);
    });
}

test("mixed qualified and bare proposals preserve IDs/arguments with one handoff", async () => {
    const { mapper, stream, output, handoffs } = mapperFor();
    const args = [{ command: "echo unchanged", nested: { value: 7 } }, { file_path: "a.txt", old_string: "a", new_string: "b" }];
    const records = toolUseEvents({ messageId: "msg", toolUseId: "bash-id", name: "Bash", partialJson: JSON.stringify(args[0]) });
    for (const event of records.slice(0, -1)) mapper.accept(event);
    const second = toolUseEvents({ messageId: "unused", toolUseId: "edit-id", name: "mcp__pi__Edit", partialJson: JSON.stringify(args[1]), messageStop: true });
    for (const record of second.slice(1)) {
        if ("index" in record.event) record.event.index = 1;
        mapper.accept(record);
    }
    assert.equal(handoffs(), 1);
    assert.equal(mapper.toolNameNormalizationCount, 1);
    assert.equal(mapper.toolNameMismatch, undefined);
    assert.deepEqual(output.content, [
        { type: "toolCall", id: "bash-id", name: "Bash", arguments: args[0] },
        { type: "toolCall", id: "edit-id", name: "Edit", arguments: args[1] },
    ]);
    mapper.completeToolUse();
    mapper.completeToolUse();
    const events = [];
    for await (const event of stream) events.push(event.type);
    assert.equal(events.filter((type) => type === "done").length, 1);
    assert.equal((await stream.result()).stopReason, "toolUse");
    assert.equal(mapperFor().mapper.toolNameNormalizationCount, 0);
});

for (const partialJson of ["{bad", "[]", "null", '"text"']) {
    test(`bare name does not repair invalid arguments: ${partialJson}`, () => {
        const { mapper, handoffs } = mapperFor();
        for (const event of toolUseEvents({ messageId: "msg", toolUseId: "id", name: "Bash", partialJson })) mapper.accept(event);
        assert.match(mapper.deferredFailure, /invalid arguments/);
        assert.throws(() => mapper.completeToolUse(), /invalid arguments/);
        // The tool stop requests child termination, but cannot publish Pi success.
        assert.equal(handoffs(), 1);
        assert.equal(mapper.isTerminal, false);
        assert.equal(mapper.toolNameNormalizationCount, 1);
    });
}
