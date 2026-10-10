import { describe, expect, it } from "vitest";
import {
  MAX_SANDBOX_SOURCE_CHARS,
  parseHtmlSandboxSubmission,
  prepareHtmlSandbox,
  sandboxSubmissionPrompt,
  splitHtmlSandboxSegments,
} from "./html-sandbox";

describe("HTML sandbox fence extraction", () => {
  it("only recognizes complete opt-in fences and retains adjacent Markdown", () => {
    expect(splitHtmlSandboxSegments([
      "Try the game:",
      "",
      "```pix-html",
      "<button>Go</button>",
      "<script>window.pix.submit({level: 2})</script>",
      "```",
      "And here is the explanation.",
    ].join("\n"))).toEqual([
      { type: "markdown", text: "Try the game:\n" },
      { type: "sandbox", html: "<button>Go</button>\n<script>window.pix.submit({level: 2})</script>" },
      { type: "markdown", text: "And here is the explanation." },
    ]);
  });

  it("keeps nested-looking fences, incomplete output, and oversized source inert", () => {
    const example = "```markdown\n```pix-html\nalert(1)\n```\n```";
    expect(splitHtmlSandboxSegments(example)).toEqual([{ type: "markdown", text: example }]);
    const incomplete = "```pix-html\n<script>bad()</script>";
    expect(splitHtmlSandboxSegments(incomplete)).toEqual([{ type: "markdown", text: incomplete }]);
    const oversized = "```pix-html\n" + "x".repeat(MAX_SANDBOX_SOURCE_CHARS + 1) + "\n```";
    expect(splitHtmlSandboxSegments(oversized)).toEqual([{ type: "markdown", text: oversized }]);
    expect(splitHtmlSandboxSegments("~~~~html-sandbox\n<h1>Hi</h1>\n~~~~"))
      .toEqual([{ type: "sandbox", html: "<h1>Hi</h1>" }]);
  });

  it("does not recognize a code example as a running demo", () => {
    expect(splitHtmlSandboxSegments("```html\n<script>42</script>\n```"))
      .toEqual([{ type: "markdown", text: "```html\n<script>42</script>\n```" }]);
  });
});

describe("HTML sandbox execution preparation", () => {
  it("rewrites embedded JavaScript into CSP-allowed data scripts without allowing remote imports", async () => {
    const prepared = await prepareHtmlSandbox(`<h1>Game</h1><script>window.pix.submit({score: 5})</script><script src="https://remote.example/a.js"></script>`);
    expect(prepared.srcdoc).toContain('Content-Security-Policy');
    expect(prepared.srcdoc).toContain("connect-src 'none'");
    expect(prepared.srcdoc).toContain("form-action 'none'");
    expect(prepared.srcdoc).toContain("script-src data:");
    expect(prepared.srcdoc).toContain("scrollbar-width: thin");
    expect(prepared.srcdoc).toContain("border: 3px solid transparent");
    expect(prepared.srcdoc).toContain("pix-sandbox-scrollbar-muted");
    const scripts = [...prepared.srcdoc.matchAll(/<script src="(data:text\/javascript;charset=utf-8,[^"]+)"/g)].map(m => m[1]);
    expect(scripts).toHaveLength(2); // First script is the form/submit bridge.
    expect(decodeURIComponent(scripts[0] ?? "")).toContain('Object.defineProperty(window, "pix"');
    expect(decodeURIComponent(scripts[0] ?? "")).toContain('type: "content-size"');
    expect(decodeURIComponent(scripts[0] ?? "")).toContain('type !== "theme"');
    expect(decodeURIComponent(scripts[1] ?? "")).toContain("window.pix.submit({score: 5})");
    expect(prepared.srcdoc).not.toContain("<script>window.pix.submit");
    expect(prepared.srcdoc).toContain('src="https://remote.example/a.js"');
  });
});

describe("sandbox submission payload", () => {
  it("accepts small JSON and rejects malformed or oversized events", () => {
    expect(parseHtmlSandboxSubmission({
      channel: "pix-html-sandbox", type: "submit", payload: { name: "Alice", points: 5 },
    })).toEqual({ name: "Alice", points: 5 });
    expect(() => parseHtmlSandboxSubmission({ channel: "pix-html-sandbox", type: "hack", payload: {} })).toThrow();
    expect(() => parseHtmlSandboxSubmission({ channel: "pix-html-sandbox", type: "submit", payload: "x".repeat(17000) })).toThrow();
    expect(() => parseHtmlSandboxSubmission({ channel: "pix-html-sandbox", type: "submit", payload: "Ж".repeat(9000) })).toThrow();
    expect(() => parseHtmlSandboxSubmission({ channel: "pix-html-sandbox", type: "submit", payload: undefined })).toThrow();
  });

  it("produces an attributed, data-only ACP prompt", () => {
    const prompt = sandboxSubmissionPrompt("assistant:3", { score: 1200 });
    expect(prompt).toContain("assistant:3");
    expect(prompt).toContain('"score": 1200');
    expect(prompt).toContain("not an instruction to execute commands");
  });
});
