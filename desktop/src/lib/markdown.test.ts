import { describe, expect, it } from "vitest";
import {
  normalizeHomeFileDestination,
  normalizeLocalFileDestination,
  normalizeProjectFileDestination,
  renderMarkdown,
  stripDcpControlMetadata,
} from "./markdown";

describe("renderMarkdown", () => {
  it("embeds project, absolute, file URI and home GLB links, but not remote links or code", () => {
    for (const path of ["models/chair.glb", "/tmp/chair.GLB", "file:///tmp/chair.glb", "~/models/chair.glb"]) {
      const html = renderMarkdown(`[Chair](${path})`);
      expect(html).toMatch(/data-(?:project|local)-media="model"/);
      expect(html).toContain("markdown-media-caption");
    }
    expect(renderMarkdown("[Chair](https://example.org/chair.glb)")).not.toContain('media="model"');
    expect(renderMarkdown("`[Chair](models/chair.glb)`")).not.toContain('media="model"');
    expect(renderMarkdown("```md\n[Chair](models/chair.glb)\n```")).not.toContain('media="model"');
  });
  it("renders the transcript Markdown subset", () => {
    const html = renderMarkdown([
      "## Result",
      "",
      "Use **bold**, *emphasis*, ***both***, ~~old~~, and `code`.",
      "",
      "- first",
      "- [x] done",
      "",
      "> quoted",
    ].join("\n"));

    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<strong><em>both</em></strong>");
    expect(html).toContain("<del>old</del>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul><li>first</li><li class=\"task-item\"><input type=\"checkbox\" disabled checked>done</li></ul>");
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(html).not.toContain('class="selection-ink"');
  });

  it("typesets inline math and display fractions with Cyrillic labels", () => {
    const result = renderMarkdown([
      "DER: \\(x^2 + \\alpha\\) and $a+b$.",
      "",
      "\\[",
      "DER=\\frac{\\text{пропущенная речь}+\\text{лишняя речь}}{\\text{эталонное время}}\\times100\\%",
      "\\]",
      "",
      "$$JER=1-\\frac{|A\\cap B|}{|A\\cup B|}$$",
    ].join("\n"));

    expect(result).toContain('class="markdown-math-inline"');
    expect(result).toContain('class="markdown-math-display"');
    expect(result).toContain('class="katex-display"');
    expect(result).toContain("пропущенная речь");
    expect(result).toContain("JER");
    expect(result).toContain('class="katex-mathml"');
  });

  it("keeps math in code literal and escapes unsafe or invalid math", () => {
    const code = renderMarkdown("`$x^2$`\n\n```tex\n\\frac{a}{b}\n```");
    expect(code).not.toContain('class="katex"');
    expect(code).toContain("$x^2$");

    const escaped = renderMarkdown("The price is \\$5, not $x$. Use \\$literal and `$y$`.");
    expect((escaped.match(/markdown-math-inline/g) ?? [])).toHaveLength(1);
    expect(escaped).toContain("$5");

    const invalid = renderMarkdown("\\[\\notacommand{<img src=x>}\\]");
    expect(invalid).toContain("markdown-math-fallback");
    expect(invalid).toContain("&lt;img src=x&gt;");
    expect(invalid).not.toContain("<img");
  });

  it("shows the original text of an incomplete display formula while streaming", () => {
    const partial = renderMarkdown("Before\n\n\\[\n\\frac{a}{");
    expect(partial).toContain("Before");
    expect(partial).toContain("markdown-math-fallback");
    expect(partial).toContain("\\frac{a}{");
    expect(partial).toContain("\\[");
    expect(renderMarkdown("\\[\\frac{a}{b}\\]")).toContain('class="katex-display"');
    const prose = renderMarkdown("\\(x\\) and then text.");
    expect(prose).toContain("markdown-math-inline");
    expect(renderMarkdown("\\[a+b\\] and prose")).toContain("and prose");
  });

  it("renders complete and streaming fenced code without interpreting its contents", () => {
    const complete = renderMarkdown("```ts\nconst tag = '<script>';\n```");
    const streaming = renderMarkdown("```ts\nconst tag = '<script>';\n");

    expect(complete).toContain('<code class="highlighted-code" data-language="typescript">');
    expect(complete).toContain('data-code-source="const tag = &#39;&lt;script&gt;&#39;;"');
    expect(complete).toContain('class="sh__token--keyword"');
    expect(complete).toContain("&lt;script&gt;");
    expect(complete).not.toContain("<script>");
    expect(streaming).toContain('<code class="highlighted-code" data-language="typescript">');
    expect(streaming).toContain("&lt;script&gt;");
    expect(streaming).not.toContain("```");
  });

  it("hides complete DCP control blocks while preserving literal examples", () => {
    const leaked = [
      "before",
      "<dcp-message-ids>",
      "Stable DCP IDs: m001=this message",
      "</dcp-message-ids>",
      "after",
    ].join("\n");
    const literal = [
      "```xml",
      "<dcp-message-ids>",
      "example",
      "</dcp-message-ids>",
      "```",
      "> <dcp-message-ids>",
      "> quoted example",
      "> </dcp-message-ids>",
    ].join("\n");

    expect(stripDcpControlMetadata(leaked)).toBe("before\nafter");
    expect(renderMarkdown(leaked)).not.toContain("Stable DCP IDs");
    expect(stripDcpControlMetadata(literal)).toBe(literal);
    expect(renderMarkdown(literal)).toContain("example");
    expect(renderMarkdown(literal)).toContain("quoted example");
  });

  it("fails open for an incomplete DCP control block", () => {
    const incomplete = "answer\n<dcp-message-ids>\nstill streaming";
    expect(stripDcpControlMetadata(incomplete)).toBe(incomplete);
    expect(renderMarkdown(incomplete)).toContain("still streaming");
  });

  it("uses plaintext highlighting for unknown fence languages", () => {
    const html = renderMarkdown("```unknown-lang\n<tag>\n```");

    expect(html).toContain('data-language="plaintext"');
    expect(html).toContain("&lt;tag&gt;");
    expect(html).not.toContain("<tag>");
  });

  it("retains escaped raw bodies for copying tilde, empty, and streaming fences only", () => {
    expect(renderMarkdown('~~~text\n  a & "b"\n\nlast\n~~~')).toContain(
      'data-code-source="  a &amp; &quot;b&quot;\n\nlast"',
    );
    expect(renderMarkdown("```\n``` ")).toContain('data-code-source=""');
    expect(renderMarkdown("```text\nfirst\n")).toContain('data-code-source="first\n"');
    expect(renderMarkdown("Prose and `inline code`")).not.toContain("data-code-source");
  });

  it("emits safe Mermaid render targets with a readable source fallback", () => {
    const html = renderMarkdown('```mermaid\nflowchart LR\n  A["<Start>"] --> B\n```');

    expect(html).toContain('class="mermaid-diagram"');
    expect(html).toContain('data-mermaid-source="flowchart LR\n  A[&quot;&lt;Start&gt;&quot;] --&gt; B"');
    expect(html).toContain('class="mermaid-canvas"');
    expect(html).toContain('<code>flowchart LR\n  A[&quot;&lt;Start&gt;&quot;] --&gt; B</code></pre>');
    expect(html).toContain('class="mermaid-fallback" data-code-source="flowchart LR\n  A[&quot;&lt;Start&gt;&quot;] --&gt; B"');
    expect(html).not.toContain("highlighted-code");
    expect(html).not.toContain("<Start>");
  });

  it("renders simple tables with alignment", () => {
    const html = renderMarkdown("| Name | Status | Example |\n| :-- | :--: | --: |\n| Pix | Ready | **fast** |");

    expect(html).toContain('<div class="table-scroll"><table>');
    expect(html).toContain('<th class="align-left">Name</th>');
    expect(html).toContain('<th class="align-center">Status</th>');
    expect(html).toContain('<td class="align-right"><strong>fast</strong></td>');
  });

  it("escapes raw HTML and rejects executable link destinations", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> ![preview](https://example.com/image.png) [run](javascript:alert(1)) [web](https://example.com/a?q=1&b=2)');

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("preview");
    expect(html).not.toContain("image.png");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com/a?q=1&amp;b=2"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("turns bare URLs into external links and leaves surrounding punctuation outside", () => {
    const html = renderMarkdown(
      "Visit https://www.google.com, read (https://en.wikipedia.org/wiki/Pix_(software)), or email mailto:pix@example.com.",
    );

    expect(html).toContain('<a href="https://www.google.com/" data-external-link');
    expect(html).toContain('>https://www.google.com</a>,');
    expect(html).toContain('href="https://en.wikipedia.org/wiki/Pix_(software)"');
    expect(html).toContain('>https://en.wikipedia.org/wiki/Pix_(software)</a>)');
    expect(html).toContain('href="mailto:pix@example.com"');
    expect(html).toContain('>mailto:pix@example.com</a>.');
  });

  it("does not auto-link URLs inside code or create nested links", () => {
    const html = renderMarkdown(
      "`https://code.example` [`src/App.svelte`](https://destination.example)",
    );

    expect(html).toContain("<code>https://code.example</code>");
    expect(html).toContain(
      '<a href="https://destination.example/" data-external-link rel="noopener noreferrer"><code>src/App.svelte</code></a>',
    );
    expect(html.match(/data-external-link/g)).toHaveLength(1);
    expect(html).not.toContain("data-project-file");
  });

  it("renders relative Markdown destinations as project-file validation candidates", () => {
    const html = renderMarkdown("Open [the app](./src/App.svelte) or [the guide](docs/guide%20one.md#intro).");

    expect(html).toContain('data-project-file-candidate="src/App.svelte"');
    expect(html).toContain('data-project-file-candidate="docs/guide one.md"');
    expect(html).not.toContain('href="#" data-project-file=');
    expect(html.match(/data-external-link/g)).toBeNull();
  });

  it("preserves GitHub-style source-line fragments on explicit project-file links", () => {
    const html = renderMarkdown([
      "[context.ts:156](src/knowledge/context.ts#L156)",
      "[range](src/knowledge/context.ts#L120-L148)",
      "[query](src/knowledge/context.ts?plain=1#L200)",
      "[heading](docs/guide.md#introduction)",
    ].join("\n"));

    expect(html).toContain(
      'data-project-file-candidate="src/knowledge/context.ts" data-project-file-start-line="156" data-project-file-end-line="156"',
    );
    expect(html).toContain(
      'data-project-file-candidate="src/knowledge/context.ts" data-project-file-start-line="120" data-project-file-end-line="148"',
    );
    expect(html).toContain(
      'data-project-file-candidate="src/knowledge/context.ts" data-project-file-start-line="200" data-project-file-end-line="200"',
    );
    expect(html).toContain('data-project-file-candidate="docs/guide.md">heading</span>');
  });

  it("emits inline preview targets for supported project images and videos", () => {
    const html = renderMarkdown([
      "[Before and after](.pi/artifacts/result.png)",
      "[Demo](artifacts/demo.webm)",
    ].join("\n\n"));

    expect(html).toContain('data-project-media="image"');
    expect(html).toContain('data-project-file=".pi/artifacts/result.png"');
    expect(html).toContain('data-project-media-label="Before and after"');
    expect(html).toContain('data-project-media="video"');
    expect(html).toContain('data-project-file="artifacts/demo.webm"');
    expect(html).toContain('class="markdown-media-caption"');
  });

  it("renders local Markdown image syntax as a preview without embedding remote media", () => {
    const local = renderMarkdown("![Result](artifacts/result.webp)");
    const remote = renderMarkdown("![Remote](https://example.com/result.webp)");

    expect(local).toContain('data-project-media="image"');
    expect(local).toContain('data-project-media-label="Result"');
    expect(remote).toBe("<p>Remote</p>");
    expect(remote).not.toContain("<img");
  });

  it("embeds audio for both link syntaxes with safe captions and local resolvers", () => {
    for (const extension of ["aac", "aif", "aiff", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav"]) {
      for (const prefix of ["", "!"]) {
        const project = renderMarkdown(`${prefix}[Track](music/track.${extension.toUpperCase()})`);
        expect(project).toContain('data-project-media="audio"');
        expect(project).toContain(`data-project-file="music/track.${extension.toUpperCase()}"`);
        for (const path of ["/Music/track", "file:///Music/track", "~/Music/track"]) {
          expect(renderMarkdown(`${prefix}[Track](${path}.${extension})`)).toContain('data-local-media="audio"');
        }
      }
    }
    expect(renderMarkdown('[<script>](music/track.mp3)')).not.toContain("<script>");
    expect(renderMarkdown('[Track](../track.mp3)')).not.toContain('data-project-media="audio"');
    expect(renderMarkdown('[Track](https://example.com/track.mp3)')).not.toContain('data-local-media="audio"');
    const remote = renderMarkdown('![Track](https://example.com/track.mp3?download=1)', { remoteImages: true });
    expect(remote).not.toContain("<audio");
    expect(remote).not.toContain("<img");
  });

  it("embeds remote images only when explicitly enabled", () => {
    const markdown = "![Remote](https://example.com/result.webp)";
    const preview = renderMarkdown(markdown, { remoteImages: true });

    expect(preview).toContain('<img class="markdown-remote-image"');
    expect(preview).toContain('src="https://example.com/result.webp"');
    expect(preview).toContain('alt="Remote"');
    expect(preview).toContain('referrerpolicy="no-referrer"');
    expect(renderMarkdown("![Mail](mailto:image@example.com)", { remoteImages: true }))
      .toBe("<p>Mail</p>");
  });

  it("renders linked remote images without corrupting their outer destination", () => {
    const markdown = "[![Version](https://img.shields.io/npm/v/pi-ui-extend)](https://npmjs.com/package/pi-ui-extend)";
    const transcript = renderMarkdown(markdown);
    const preview = renderMarkdown(markdown, { remoteImages: true });

    expect(transcript).toContain('href="https://npmjs.com/package/pi-ui-extend"');
    expect(transcript).toContain(">Version</a>");
    expect(transcript).not.toContain("![");
    expect(preview).toContain('href="https://npmjs.com/package/pi-ui-extend"');
    expect(preview).toContain('src="https://img.shields.io/npm/v/pi-ui-extend"');
  });

  it("adds heading ids and same-document links only when enabled", () => {
    const markdown = "[Jump](#requirements)\n\n## Requirements\n\n## Requirements";
    const preview = renderMarkdown(markdown, { headingAnchors: true });

    expect(preview).toContain('data-markdown-anchor="requirements"');
    expect(preview).toContain('<h2 id="requirements">Requirements</h2>');
    expect(preview).toContain('<h2 id="requirements-1">Requirements</h2>');
    expect(renderMarkdown(markdown)).not.toContain("data-markdown-anchor");
  });

  it("renders file URL images and videos as lazy local previews", () => {
    const html = renderMarkdown([
      "[Light initial](file:///tmp/qa-shots/01-light-initial.png)",
      "[Demo](file:///tmp/qa-shots/demo%20run.webm)",
    ].join("\n\n"));

    expect(html).toContain('data-local-media="image"');
    expect(html).toContain('data-local-file="/tmp/qa-shots/01-light-initial.png"');
    expect(html).toContain('data-local-media-label="Light initial"');
    expect(html).toContain('data-local-media="video"');
    expect(html).toContain('data-local-file="/tmp/qa-shots/demo run.webm"');
    expect(html).toContain('class="markdown-media-caption"');
    expect(html).not.toContain('class="markdown-media-frame" data-local-file=');
  });

  it("keeps non-media file and directory URLs as validation candidates without weakening project path rules", () => {
    const html = renderMarkdown([
      "[Trace](file:///tmp/qa-shots/run.trace.zip)",
      "[Evidence directory](file:///tmp/qa-shots/final-run)",
    ].join("\n"));

    expect(html).toContain('data-local-file-candidate="/tmp/qa-shots/run.trace.zip"');
    expect(html).toContain('data-local-file-candidate="/tmp/qa-shots/final-run"');
    expect(html).not.toContain("data-local-media");
    expect(normalizeLocalFileDestination("file:///tmp/result.png")).toBe("/tmp/result.png");
    expect(normalizeLocalFileDestination("file:///tmp/result%20one.png#preview")).toBe("/tmp/result one.png");
    expect(normalizeLocalFileDestination("/private/tmp/idx-compact-gate-qa/stdout.txt")).toBe("/private/tmp/idx-compact-gate-qa/stdout.txt");
    expect(normalizeLocalFileDestination("file:relative.png")).toBeUndefined();
    expect(normalizeLocalFileDestination("file:///tmp/%00result.png")).toBeUndefined();
    expect(normalizeLocalFileDestination("https://example.com/result.png")).toBeUndefined();
    expect(normalizeProjectFileDestination("file:///tmp/result.png")).toBeUndefined();
  });

  it("renders raw absolute Markdown image and video destinations as local previews", () => {
    const html = renderMarkdown([
      "[Screenshot](/Volumes/128GBSSD/Projects/game-tactical/.pi/artifacts/ui-qa/run/front.png)",
      "![Result](</tmp/qa shots/result.webp>)",
      "[Demo](/tmp/qa-shots/demo%20run.mp4)",
    ].join("\n\n"));

    expect(html).toContain('data-local-media="image"');
    expect(html).toContain('data-local-file="/Volumes/128GBSSD/Projects/game-tactical/.pi/artifacts/ui-qa/run/front.png"');
    expect(html).toContain('data-local-file="/tmp/qa shots/result.webp"');
    expect(html).toContain('data-local-media="video"');
    expect(html).toContain('data-local-file="/tmp/qa-shots/demo run.mp4"');
    expect(html).not.toContain("data-project-media");
  });

  it("escapes media labels and does not preview unsupported project files", () => {
    const media = renderMarkdown('[A & "B"](artifacts/result.png)');
    const binary = renderMarkdown("[Archive](artifacts/result.zip)");

    expect(media).toContain('data-project-media-label="A &amp; &quot;B&quot;"');
    expect(binary).not.toContain("data-project-media");
    expect(binary).toContain('data-project-file-candidate="artifacts/result.zip"');
  });

  it("turns inline-code project file paths into validation candidates", () => {
    const html = renderMarkdown(
      "Changed `desktop/src/components/TranscriptPane.svelte` and `src/App.svelte:42`.",
    );

    expect(html).toContain(
      'data-project-file-candidate="desktop/src/components/TranscriptPane.svelte"',
    );
    expect(html).toContain("<code>desktop/src/components/TranscriptPane.svelte</code>");
    expect(html).toContain('data-project-file-candidate="src/App.svelte"');
    expect(html).toContain('data-project-file-start-line="42"');
    expect(html).toContain('data-project-file-end-line="42"');
  });

  it("preserves inline-code project line ranges for preview navigation", () => {
    const html = renderMarkdown(
      "Inspect `external/pi-tools-suite/src/dcp/index.ts:120-148` and `desktop/src/App.svelte:3309:17`.",
    );

    expect(html).toContain('data-project-file-candidate="external/pi-tools-suite/src/dcp/index.ts"');
    expect(html).toContain('data-project-file-start-line="120"');
    expect(html).toContain('data-project-file-end-line="148"');
    expect(html).toContain('data-project-file-candidate="desktop/src/App.svelte"');
    expect(html).toContain('data-project-file-start-line="3309"');
    expect(html).toContain('data-project-file-end-line="3309"');
  });

  it("turns home-relative file paths into local validation candidates", () => {
    const html = renderMarkdown(
      "Open `~/.config/pi/pix.jsonc` or [the config](~/.config/pi/pix.jsonc).",
    );

    expect(html.match(/data-local-file-candidate="~\/.config\/pi\/pix.jsonc"/g)).toHaveLength(2);
    expect(html).not.toContain('href="#" data-local-file=');
    expect(html).not.toContain('data-project-file="~/.config/pi/pix.jsonc"');
  });

  it("turns inline-code absolute file paths into local validation candidates", () => {
    const html = renderMarkdown("Inspect `/private/tmp/idx-compact-gate-qa/stdout.txt`.");
    expect(html).toContain('data-local-file-candidate="/private/tmp/idx-compact-gate-qa/stdout.txt"');
    expect(html).toContain("<code>/private/tmp/idx-compact-gate-qa/stdout.txt</code>");
  });

  it.each([
    ["/Volumes/128GBSSD/Projects/game-tactical/.pi/artifacts/ui-qa/run/front.png", "image"],
    ["/tmp/qa shots/result.webp", "image"],
    ["/tmp/demo.mp4", "video"],
    ["/tmp/demo.webm", "video"],
    ["file:///tmp/result%20one.png", "image"],
  ])("previews inline-code absolute media %s via the local resolver", (path, kind) => {
    const html = renderMarkdown(`\`${path}\``);
    expect(html).toContain(`data-local-media="${kind}"`);
    expect(html).toContain(`data-local-file="${normalizeLocalFileDestination(path)}"`);
    expect(html).toContain(`<code>${path}</code>`);
    expect(html).toContain('class="markdown-media-caption"');
    expect(html).toContain('class="markdown-media-frame"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("data-project-media");
  });

  it("escapes inline-code media paths and keeps invalid or non-media paths out of previews", () => {
    const media = renderMarkdown('`/tmp/A & "B".png`');
    expect(media).toContain('data-local-file="/tmp/A &amp; &quot;B&quot;.png"');
    expect(media).toContain('<code>/tmp/A &amp; &quot;B&quot;.png</code>');
    for (const path of ["/tmp/report.zip", "/tmp/evidence/", "file:///tmp/%00result.png", "https://example.com/result.png"]) {
      expect(renderMarkdown(`\`${path}\``)).not.toContain("data-local-media");
    }
    expect(renderMarkdown("[`/tmp/result.png`](https://example.com)")).not.toContain("data-local-media");
    expect(renderMarkdown("```\n/tmp/result.png\n```")).not.toContain("data-local-media");
  });

  it.each([
    [".pi/artifacts/usage-popup-mockups/", ".pi/artifacts/usage-popup-mockups"],
    ["src/components/", "src/components"],
    ["docs/", "docs"],
    [".pi\\artifacts\\usage-popup-mockups\\", ".pi/artifacts/usage-popup-mockups"],
  ])("recognizes inline-code directory %s as a validation candidate", (path, normalized) => {
    const html = renderMarkdown(`Файлы сохранены в \`${path}\` (SVG + PNG обоих размеров).`);
    expect(html).toContain(`data-project-file-candidate="${normalized}"`);
    expect(html).toContain(`<code>${path}</code>`);
    expect(html).not.toContain('href="#" data-project-file=');
    expect(html).not.toContain("data-project-media");
  });

  it.each(["../private/", ".pi/../../private/", "%2e%2e/private/", "src/%00private/", "https://example.com/folder/"])(
    "rejects unsafe inline-code directory %s",
    (path) => {
      expect(renderMarkdown(`\`${path}\``)).not.toContain("data-project-file");
    },
  );

  it("keeps ordinary inline code as code", () => {
    const html = renderMarkdown("Run `npm run check` and call `value.toString()`.");

    expect(html).not.toContain("data-project-file");
    expect(html).toContain("<code>npm run check</code>");
    expect(html).toContain("<code>value.toString()</code>");
  });

  it.each([
    "exports/voice_auditions/player/01_M_Supertonic_M1.mp3",
    "01_M_Supertonic_M1.lrc",
    "repo_architecture, repo_search",
    "foo__bar__baz foo___bar___baz",
    "имя_файла_1.txt",
  ])("preserves intraword underscores in %s", (text) => {
    expect(renderMarkdown(text)).toBe(`<p>${text}</p>`);
  });

  it("preserves filename underscores in file links and audio captions", () => {
    for (const extension of ["mp3", "lrc"]) {
      const name = `01_M_Supertonic_M1.${extension}`;
      const html = renderMarkdown(`[${name}](exports/voice_auditions/player/${name})`);
      expect(html).toContain(`>${name}</span>`);
      expect(html).toContain(`exports/voice_auditions/player/${name}`);
      expect(html).not.toContain("<em>");
    }
  });

  it("renders standalone underscore emphasis without consuming identifier underscores", () => {
    expect(renderMarkdown("_italic_ __bold__ ___both___")).toBe(
      "<p><em>italic</em> <strong>bold</strong> <strong><em>both</em></strong></p>",
    );
    expect(renderMarkdown("(_курсив_) _foo_bar_ __foo__bar__")).toBe(
      "<p>(<em>курсив</em>) <em>foo_bar</em> <strong>foo__bar</strong></p>",
    );
    for (const text of ["_ leading_", "_trailing _", "word_italic_", "_italic_word"]) {
      expect(renderMarkdown(text)).toBe(`<p>${text}</p>`);
    }
    expect(renderMarkdown("_still_streaming")).toBe("<p>_still_streaming</p>");
    expect(renderMarkdown("_escaped\\_underscore_")).toBe("<p><em>escaped_underscore</em></p>");
  });

  it("renders escaped underscores in inventory identifiers literally", () => {
    const html = renderMarkdown("Tools (active): repo\\_architecture, repo\\_search");

    expect(html).toContain("repo_architecture, repo_search");
    expect(html).not.toContain("<em>");
  });

  it("rejects project-file destinations that are absolute, traversing, or URL-like", () => {
    expect(normalizeProjectFileDestination("src/main.ts")).toBe("src/main.ts");
    expect(normalizeProjectFileDestination("./docs/readme.md#usage")).toBe("docs/readme.md");
    expect(normalizeProjectFileDestination("../secret.txt")).toBeUndefined();
    expect(normalizeProjectFileDestination("%2e%2e/secret.txt")).toBeUndefined();
    expect(normalizeProjectFileDestination("src/%00secret.txt")).toBeUndefined();
    expect(normalizeProjectFileDestination("/tmp/file.txt")).toBeUndefined();
    expect(normalizeProjectFileDestination("~/.config/pi/pix.jsonc")).toBeUndefined();
    expect(normalizeProjectFileDestination("C:\\tmp\\file.txt")).toBeUndefined();
    expect(normalizeProjectFileDestination("https://example.com/file.ts")).toBeUndefined();
  });

  it("normalizes confined home-relative destinations", () => {
    expect(normalizeHomeFileDestination("~/.config/pi/pix.jsonc")).toBe("~/.config/pi/pix.jsonc");
    expect(normalizeHomeFileDestination("~\\.config\\pi\\pix.jsonc#preview"))
      .toBe("~/.config/pi/pix.jsonc");
    expect(normalizeHomeFileDestination("~/../secret.txt")).toBeUndefined();
    expect(normalizeHomeFileDestination("~/%2e%2e/secret.txt")).toBeUndefined();
    expect(normalizeHomeFileDestination("/tmp/file.txt")).toBeUndefined();
    expect(normalizeHomeFileDestination("~other/file.txt")).toBeUndefined();
  });

  it("keeps incomplete inline markers readable while chunks stream", () => {
    expect(renderMarkdown("Answer **still streaming")).toBe("<p>Answer **still streaming</p>");
    expect(renderMarkdown("Use [partial")).toBe("<p>Use [partial</p>");
  });
});
