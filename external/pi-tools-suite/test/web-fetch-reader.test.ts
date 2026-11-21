import { describe, expect, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";
import type { IncomingHttpHeaders } from "node:http";
import { extractPageMarkdown } from "../src/web-search/page-markdown.js";
import { createPublicLookup, downloadPublicPage, MAX_PAGE_BYTES, parsePublicPageUrl } from "../src/web-search/public-page.js";

function response(chunks: Buffer[], headers: IncomingHttpHeaders, statusCode = 200) {
	return Object.assign(Readable.from(chunks), { headers, statusCode });
}

describe("local page reader", () => {
	test("extracts the main content with Markdown structure, without running scripts or embedding images", () => {
		const { title, content } = extractPageMarkdown(`<!doctype html><html><head><title>Docs &amp; examples</title></head>
			<body><nav>Hidden menu</nav><article>Unrelated article</article><main><h1>Quick start</h1>
			<p>Caf&eacute; <strong>example</strong> and <a href="../docs">docs</a>.
			<a href="javascript:alert(1)">Not a link</a><img src="https://example.net/pixel" alt="Illustration"></p>
			<ul><li>First</li><li>Second</li></ul><pre><code class="language-js">  const x = 1;
			  // Contains a triple fence: &#96;&#96;&#96;</code></pre>
			<table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1 | 2</td></tr></table>
			<script>unsafe script</script><p hidden>Hidden paragraph</p></main><footer>Page footer</footer></body></html>`,
		new URL("https://example.com/path/page"));
		expect(title).toBe("Docs & examples");
		for (const expected of ["# Quick start", "Café **example**", "[docs](/docs)", "- First\n- Second",
			"````js\n  const x = 1;", "| Name | Value |\n| --- | --- |\n| A | 1 \\| 2 |", "Not a link", "Illustration"]) {
			expect(content).toContain(expected);
		}
		for (const unexpected of ["Hidden", "Unrelated", "javascript:", "example.net/pixel", "unsafe script", "Page footer"]) {
			expect(content).not.toContain(unexpected);
		}
	});

	test("uses article or body when there is no readable main and accepts ordinary malformed HTML", () => {
		const url = new URL("https://example.com/");
		expect(extractPageMarkdown("<nav>Menu</nav><article><h1>Heading</h1><p>First<p>Second", url)).toMatchObject({ title: "Heading" });
		expect(extractPageMarkdown("<main><script>hidden()</script></main><p>Outside", url).content).toBe("Outside");
		expect(extractPageMarkdown("<body><nav>Menu</nav><script>hidden()</script>", url).content).toBe("");
	});

	test("drops page chrome, anchors, link bars, layout tables and duplicate image descriptions", () => {
		const url = new URL("https://example.com/docs/page#intro");
		const { title, content } = extractPageMarkdown(`<title>Guide</title><main>
			<h1>Guide</h1><div class="infobox">Infobox noise</div><div class="sr-only">Skip link</div>
			<h2><a href="#usage">Usage</a></h2><p>See note<a href="#cite-1">[1]</a> and <a href="/other">other page</a>
			and <a href="https://elsewhere.example/x">external</a>.</p>
			<div><a href="/a">Home</a> | <a href="/b">Blog</a> | <a href="/c">About</a></div>
			<ul><li><a href="/x">X</a></li><li><a href="/y">Y</a></li></ul>
			<table><tr><td>Layout cell text</td><td><a href="javascript:void(0)">[–]</a></td></tr></table>
			<img alt="Diagram"><img alt="Diagram"><hr></main>`, url);
		expect(title).toBe("Guide");
		for (const expected of ["## Usage", "See note\\[1\\] and [other page](/other)", "[external](https://elsewhere.example/x)",
			"Layout cell text", "Diagram"]) {
			expect(content).toContain(expected);
		}
		for (const unexpected of ["# Guide", "Infobox", "Skip link", "#usage", "#cite-1", "Home", "[X]", "| ---", "[–]", "javascript:"]) {
			expect(content).not.toContain(unexpected);
		}
		expect(content.match(/Diagram/g)).toHaveLength(1);
		expect(content.endsWith("---")).toBe(false);
	});

	test("keeps real data tables and long headline links", () => {
		const url = new URL("https://example.com/");
		const rows = Array.from({ length: 12 }, (_, i) => `<tr><td>r${i}</td><td>${i}</td></tr>`).join("");
		expect(extractPageMarkdown(`<main><table>${rows}</table></main>`, url).content).toContain("| r11 | 11 |");
		const headlines = ["First long headline about something", "Second long headline about another thing",
			"Third long headline describing the news"].map((text, i) => `<a href="/s${i}">${text}</a>`).join(" | ");
		expect(extractPageMarkdown(`<main><div>${headlines}</div></main>`, url).content).toContain("Third long headline");
	});
});

describe("public page transport", () => {
	test("rejects private, local, mapped and reserved literals after URL normalization", () => {
		for (const host of ["0.0.0.0", "2130706433", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1",
			"192.168.0.1", "198.18.0.1", "224.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "[64:ff9b::7f00:1]",
			"[fc00::1]", "[fe80::1]", "[2001:db8::1]", "[2002:7f00:1::]"]) {
			expect(() => parsePublicPageUrl(`http://${host}/`)).toThrow("private or reserved");
		}
		expect(parsePublicPageUrl("https://1.1.1.1/").hostname).toBe("1.1.1.1");
		expect(parsePublicPageUrl("https://[2606:4700:4700::1111]/").hostname).toBe("[2606:4700:4700::1111]");
	});

	test("hands the checked DNS answer to the socket and rejects a mixed public/private answer", () => {
		const answers = [{ address: "1.1.1.1", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
		let lookups = 0;
		const checked = createPublicLookup((_host, options, callback) => {
			lookups++;
			expect(options.all).toBe(true);
			callback(null, answers);
		});
		checked("public.example", { all: true }, (error, addresses) => {
			expect(error).toBeNull();
			expect(addresses).toEqual(answers);
		});
		checked("public.example", {}, (error, address, family) => {
			expect(error).toBeNull();
			expect([address, family]).toEqual(["1.1.1.1", 4]);
		});
		answers.push({ address: "127.0.0.1", family: 4 });
		checked("public.example", { all: true }, (error, addresses) => {
			expect(error?.message).toContain("private or reserved");
			expect(addresses).toBe("");
		});
		expect(lookups).toBe(3);
	});

	test("follows relative redirects, uses the final URL and decodes split UTF-8 sequences", async () => {
		const redirects = response([], { location: "/final/page" }, 302);
		const bytes = Buffer.from("Café");
		const urls: string[] = [];
		const page = await downloadPublicPage(new URL("https://example.com/first"), new AbortController().signal, async (url) => {
			urls.push(url.href);
			return urls.length === 1 ? redirects : response([bytes.subarray(0, 4), bytes.subarray(4)], { "content-type": "text/plain" });
		});
		expect(urls).toEqual(["https://example.com/first", "https://example.com/final/page"]);
		expect(redirects.destroyed).toBe(true);
		expect(page).toMatchObject({ url: new URL(urls[1]), html: false, text: "Café" });
	});

	test("never opens private redirects or HTTPS downgrades and bounds redirect loops", async () => {
		const url = new URL("https://example.com/");
		const signal = new AbortController().signal;
		for (const [location, message] of [["https://127.0.0.1/private", "private or reserved"], ["http://example.com/", "HTTPS to HTTP"]]) {
			let opens = 0;
			await expect(downloadPublicPage(url, signal, async () => {
				opens++;
				return response([], { location }, 302);
			})).rejects.toThrow(message);
			expect(opens).toBe(1);
		}
		await expect(downloadPublicPage(url, signal, async () => response([], { location: "/" }, 302))).rejects.toThrow("Too many redirects");
	});

	test("retries once with a browser identity after 403/429/503 and keeps it across redirects", async () => {
		const url = new URL("https://example.com/");
		const signal = new AbortController().signal;
		for (const blocked of [403, 429, 503]) {
			const calls: string[] = [];
			const first = response([], {}, blocked);
			const page = await downloadPublicPage(url, signal, async (target, _signal, profile) => {
				calls.push(`${profile} ${target.pathname}`);
				if (calls.length === 1) return first;
				if (calls.length === 2) return response([], { location: "/next" }, 302);
				return response([Buffer.from("ok")], { "content-type": "text/plain" });
			});
			expect(calls).toEqual(["reader /", "browser /", "browser /next"]);
			expect(first.destroyed).toBe(true);
			expect(page.text).toBe("ok");
		}
		let opens = 0;
		await expect(downloadPublicPage(url, signal, async () => {
			opens++;
			return response([], {}, 403);
		})).rejects.toThrow("HTTP 403");
		expect(opens).toBe(2);
		const profiles: string[] = [];
		await expect(downloadPublicPage(url, signal, async (_target, _signal, profile) => {
			profiles.push(profile ?? "");
			return response([], {}, 404);
		})).rejects.toThrow("HTTP 404");
		expect(profiles).toEqual(["reader"]);
	});

	test("caps streamed input, declines binary data, and destroys a cancelled body", async () => {
		const url = new URL("https://example.com/");
		const controller = new AbortController();
		const huge = response([Buffer.alloc(MAX_PAGE_BYTES), Buffer.from("a")], { "content-type": "text/html" });
		await expect(downloadPublicPage(url, controller.signal, async () => huge)).rejects.toThrow("1 MiB limit");
		expect(huge.destroyed).toBe(true);
		await expect(downloadPublicPage(url, controller.signal, async () => response([], { "content-type": "application/pdf" })))
			.rejects.toThrow("Unsupported content type: application/pdf");
		const stalled = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "text/plain" } });
		const result = downloadPublicPage(url, controller.signal, async () => stalled);
		await Promise.resolve();
		controller.abort();
		await expect(result).rejects.toThrow();
		expect(stalled.destroyed).toBe(true);
	});
});
