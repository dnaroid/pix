import { describe, expect, it } from "vitest";
import { newerDcpContextMap, parseDcpContextMap } from "./dcp-context-map";
import { parseRuntimeStatus } from "./acp-response-parsers";

const map = { revision: 2, sessionEpoch: 1, generatedAt: 100,
  tokenEstimates: { candidate: 2, protected: 0, compressed: 3, retained: 5 } };

describe("DCP scalar token metadata", () => {
  it("allowlists metadata and accepts explicit zero categories", () => {
    const parsed = parseDcpContextMap({ ...map, body: "private", tokenEstimates: { ...map.tokenEstimates, body: "private" } });
    expect(parsed).toEqual(map);
    expect(parsed).not.toBe(map);
    expect(parsed?.tokenEstimates).not.toBe(map.tokenEstimates);
  });
  it("fails closed on malformed or unsafe metadata", () => {
    for (const invalid of [null, {}, { ...map, revision: 0 }, { ...map, sessionEpoch: -1 },
      { ...map, generatedAt: Number.MAX_SAFE_INTEGER }, { ...map, tokenEstimates: {} },
      ...[-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER, "1"].map((candidate) => ({ ...map, tokenEstimates: { ...map.tokenEstimates, candidate } })),
      { ...map, tokenEstimates: { candidate: 0, protected: 0, compressed: 0, retained: 0 } },
    ]) expect(parseDcpContextMap(invalid)).toBeUndefined();
  });
  it("rejects stale owners/revisions and explicitly clears unavailable data", () => {
    expect(newerDcpContextMap(map, { ...map, revision: 1 })).toBe(map);
    expect(newerDcpContextMap(map, { ...map, sessionEpoch: 0, revision: 99 })).toBe(map);
    const newerOwner = { ...map, sessionEpoch: 2, revision: 1 };
    expect(newerDcpContextMap(map, newerOwner)).toBe(newerOwner);
    expect(newerDcpContextMap(map, undefined)).toBeUndefined();
  });
  it("parses the same payload through runtime status without failing legacy responses", () => {
    const status = { sessionId: "a", modelUsageRefresh: "skipped", dcpContextMap: map };
    expect(parseRuntimeStatus(status).dcpContextMap).toEqual(map);
    expect(parseRuntimeStatus({ ...status, dcpContextMap: null }).dcpContextMap).toBeUndefined();
    expect(parseRuntimeStatus({ ...status, dcpContextMap: { invalid: true } }).dcpContextMap).toBeUndefined();
  });
});
