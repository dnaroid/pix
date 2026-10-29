import { describe, expect, it, vi } from "vitest";
import { AcpPixExtensions, type AcpRequest } from "./acp-pix-extensions";

describe("file mention transport", () => {
  it("uses workspace in sessionless drafts, forwards cancellation and returns paths only", async () => {
    const matches = [{ path: "src/", directory: true }];
    const request = vi.fn().mockResolvedValue({ matches });
    const signal = new AbortController().signal;
    const client = new AcpPixExtensions(request as AcpRequest);
    expect(await client.fileMentions("/project", "sr", signal)).toEqual(matches);
    expect(request).toHaveBeenCalledWith("pix/files/complete", { cwd: "/project", query: "sr" }, null, signal);
  });
  it.each([{}, { matches: ["src"] }, { matches: [{ path: "src" }] }, { matches: [{ path: 3, directory: false }] }])("rejects a malformed response", async (response) => {
    const client = new AcpPixExtensions(vi.fn().mockResolvedValue(response) as AcpRequest);
    await expect(client.fileMentions("/project", "")).rejects.toThrow("invalid response");
  });
});
