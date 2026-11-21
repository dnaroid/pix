import { lookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { addAbortSignal, type Readable } from "node:stream";
import { MIMEType } from "node:util";

export const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const nonPublicV4 = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
	["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
	["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) nonPublicV4.addSubnet(address, prefix);

// Reject mapped IPv4, translation prefixes, local and reserved space outside global unicast.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const specialV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
	specialV6.addSubnet(address, prefix, "ipv6");
}

function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return !nonPublicV4.check(address);
	return family === 6 && globalV6.check(address, "ipv6") && !specialV6.check(address, "ipv6");
}

function blockedAddress(): Error {
	return new Error("Target resolves to a private or reserved network address.");
}

export function parsePublicPageUrl(input: string, base?: URL): URL {
	const url = URL.parse(input, base);
	if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
		throw new Error("web_fetch requires a public HTTP(S) URL without embedded credentials.");
	}
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(hostname) && !isPublicAddress(hostname)) throw blockedAddress();
	return url;
}

type ResolveAddresses = (hostname: string, options: LookupAllOptions,
	callback: (error: NodeJS.ErrnoException | null, answers: LookupAddress[]) => void) => void;

// Pass the checked answers to the connecting socket, rather than resolving a second time.
export function createPublicLookup(resolve: ResolveAddresses = lookup): LookupFunction {
	return (hostname, options, callback) => {
		resolve(hostname, { ...options, all: true }, (error, answers) => {
			if (error) return callback(error, "");
			if (!answers.length || answers.some(({ address }) => !isPublicAddress(address))) {
				return callback(blockedAddress(), "");
			}
			if (options.all) return callback(null, answers);
			const { address, family } = answers[0];
			callback(null, address, family);
		});
	};
}

type PageResponse = Readable & {
	statusCode?: number;
	headers: IncomingHttpHeaders;
};

const publicLookup = createPublicLookup();

export type RequestProfile = "reader" | "browser";

// The reader identity is honest: a "Mozilla" token on a non-browser TLS fingerprint is treated as a spoofed
// browser by some sites (Hacker News answers HTTP 419). Sites that block unknown agents instead (403/429/503)
// get one retry with a browser identity.
const REQUEST_HEADERS: Record<RequestProfile, Record<string, string>> = {
	reader: {
		"User-Agent": "Pix-Reader/1.0 (reader)",
		Accept: "text/markdown,text/html;q=0.9,application/xhtml+xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.1",
	},
	browser: {
		"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	},
};
const BROWSER_RETRY_STATUS = new Set([403, 429, 503]);

function requestPublicResponse(url: URL, signal: AbortSignal, profile: RequestProfile = "reader"): Promise<PageResponse> {
	const request = url.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		request(url, {
			// Do not use a shared or environment-driven proxy agent for untrusted URLs.
			agent: false,
			lookup: publicLookup,
			signal,
			maxHeaderSize: 16 * 1024,
			headers: {
				...REQUEST_HEADERS[profile],
				"Accept-Language": "en-US,en;q=0.9",
				"Accept-Encoding": "identity",
			},
		}, resolve).once("error", reject).end();
	});
}

function classifyContent(headers: IncomingHttpHeaders): { html: boolean; charset: string } {
	const type = new MIMEType(headers["content-type"] ?? "application/octet-stream");
	const mime = type.essence;
	const html = mime === "text/html" || mime === "application/xhtml+xml";
	if (!html && !mime.startsWith("text/") &&
		!/^application\/(?:json|xml|rss\+xml|atom\+xml|yaml)$/.test(mime)) {
		throw new Error(`Unsupported content type: ${mime}.`);
	}
	return { html, charset: type.params.get("charset") || "utf-8" };
}

export async function downloadPublicPage(url: URL, signal: AbortSignal, open = requestPublicResponse) {
	let profile: RequestProfile = "reader";
	for (let redirects = 0; ;) {
		signal.throwIfAborted();
		const response = addAbortSignal(signal, await open(parsePublicPageUrl(url.href), signal, profile));
		try {
			const status = response.statusCode ?? 0;
			if (profile === "reader" && BROWSER_RETRY_STATUS.has(status)) {
				profile = "browser";
				continue;
			}
			if (REDIRECT_STATUS.has(status) && response.headers.location) {
				if (redirects++ === MAX_REDIRECTS) throw new Error("Too many redirects.");
				const next = parsePublicPageUrl(response.headers.location, url);
				if (url.protocol === "https:" && next.protocol === "http:") {
					throw new Error("Refusing an HTTPS to HTTP redirect.");
				}
				url = next;
				continue;
			}
			if (status < 200 || status >= 300) throw new Error(`Page returned HTTP ${status}.`);
			const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
			if (encoding && encoding !== "identity") throw new Error("Server ignored uncompressed content request.");
			if (Number(response.headers["content-length"]) > MAX_PAGE_BYTES) throw new Error("Page exceeds the 1 MiB limit.");
			const { html, charset } = classifyContent(response.headers);
			const decoder = new TextDecoder(charset);
			const fragments: string[] = [];
			let bytes = 0;
			for await (const chunk of response as AsyncIterable<Buffer>) {
				bytes += chunk.byteLength;
				if (bytes > MAX_PAGE_BYTES) throw new Error("Page exceeds the 1 MiB limit.");
				fragments.push(decoder.decode(chunk, { stream: true }));
			}
			fragments.push(decoder.decode());
			return { url, html, text: fragments.join("") };
		} finally {
			response.destroy();
		}
	}
}
