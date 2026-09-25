import { describe, expect, it } from "vitest";
import {
  LSP_ONBOARDING_CHANNEL,
  lspMissingSuggestionFromSessionState,
  lspServerConfigForInstall,
  piToolsSuiteConfigWithLspServer,
} from "./lsp-onboarding";

describe("LSP onboarding helpers", () => {
  it("parses only trusted missing-LSP session-state events", () => {
    const suggestion = lspMissingSuggestionFromSessionState({
      sessionId: "session-1",
      channel: LSP_ONBOARDING_CHANNEL,
      data: {
        version: 1,
        installerId: "rust",
        languageId: "rust",
        languageLabel: "Rust",
        serverLabel: "rust-analyzer",
        path: "/project/src/lib.rs",
        checkedAt: 42,
      },
    });
    expect(suggestion?.installerId).toBe("rust");
    expect(lspMissingSuggestionFromSessionState({
      sessionId: "session-1",
      channel: LSP_ONBOARDING_CHANNEL,
      data: { ...suggestion, version: 1, installerId: "../../shell" },
    })).toBeUndefined();
  });

  it("registers an installed server without replacing comments or sibling settings", () => {
    const server = lspServerConfigForInstall({
      installerId: "python",
      bin: "/Users/me/.local/share/pix/lsp/python/bin/pylsp",
      env: {},
      output: "ok",
    });
    const next = piToolsSuiteConfigWithLspServer(
      "{\n  // keep this comment\n  \"todoThinking\": true,\n  \"lsp\": { \"servers\": [{ \"id\": \"typescript\", \"bin\": \"typescript-language-server\" }] }\n}\n",
      server,
    );
    expect(next).toContain("// keep this comment");
    expect(next).toContain("\"todoThinking\": true");
    expect(next).toContain("\"id\": \"typescript\"");
    expect(next).toContain("\"id\": \"python\"");
    expect(next).toContain("/Users/me/.local/share/pix/lsp/python/bin/pylsp");
  });

  it("replaces a server with the same id instead of duplicating registration", () => {
    const server = lspServerConfigForInstall({
      installerId: "go",
      bin: "/Users/me/.local/share/pix/lsp/go/gopls",
      env: { GOBIN: "/Users/me/.local/share/pix/lsp/go" },
      output: "ok",
    });
    const next = piToolsSuiteConfigWithLspServer(
      "{\"lsp\":{\"servers\":[{\"id\":\"go\",\"bin\":\"old-gopls\"}]}}\n",
      server,
    );
    expect((next.match(/"id": "go"/g) ?? [])).toHaveLength(1);
    expect(next).not.toContain("old-gopls");
    expect(next).toContain("\"GOBIN\"");
  });

  it("preserves comments attached to sibling LSP server entries", () => {
    const server = lspServerConfigForInstall({
      installerId: "python",
      bin: "/Users/me/.local/share/pix/lsp/python/bin/pylsp",
      env: {},
      output: "ok",
    });
    const next = piToolsSuiteConfigWithLspServer(
      "{\n  \"lsp\": {\n    \"servers\": [\n      // keep TypeScript customizations\n      { \"id\": \"typescript\", \"bin\": \"typescript-language-server\" }\n    ]\n  }\n}\n",
      server,
    );
    expect(next).toContain("// keep TypeScript customizations");
    expect(next).toContain("\"id\": \"typescript\"");
    expect(next).toContain("\"id\": \"python\"");
  });
});
