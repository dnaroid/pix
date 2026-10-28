import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { renderMarkdown } from "../desktop/src/lib/markdown.ts";

// Use Desktop's actual heading IDs instead of a second, drifting slug algorithm.
const root = resolve(process.argv[2] ?? ".");
const wiki = resolve(root, "wiki");
const failures: string[] = [];
const graph = new Map<string, Set<string>>();
const headings = new Map<string, Set<string>>();
let checkedLinks = 0;
let checkedImages = 0;

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function prose(source: string): string {
  let fence: string | undefined;
  return source.split("\n").map(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? undefined : marker;
      return "";
    }
    if (fence) return "";
    return line.replace(/(`+)[\s\S]*?\1/g, "");
  }).join("\n").replace(/<!--[\s\S]*?-->/g, "");
}

function headingIds(path: string): Set<string> {
  let ids = headings.get(path);
  if (!ids) {
    const html = renderMarkdown(readFileSync(path, "utf8"), { headingAnchors: true });
    ids = new Set([...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map(match => match[1]!));
    headings.set(path, ids);
  }
  return ids;
}

function checkDestination(page: string, destination: string, image: boolean): void {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) return;
  const fail = (reason: string): void => { failures.push(`${relative(root, page)}: ${destination} — ${reason}`); };
  let decoded: string;
  try { decoded = decodeURIComponent(destination.replace(/^<|>$/g, "")); }
  catch { fail("invalid URL encoding"); return; }
  const [pathname = "", anchor] = decoded.split("#", 2);
  const target = pathname ? resolve(dirname(page), pathname.split("?", 1)[0]!) : page;
  if (relative(root, target).startsWith("..")) { fail("outside repository"); return; }
  checkedLinks += 1;
  if (image) checkedImages += 1;
  if (!existsSync(target)) { fail("missing target"); return; }
  if (anchor && extname(target) === ".md" && !headingIds(target).has(anchor)) fail(`missing heading #${anchor}`);
  if (statSync(target).isFile() && extname(target) === ".md") graph.get(page)?.add(target);
}

if (!existsSync(wiki)) {
  console.error("Missing wiki/ directory");
  process.exit(1);
}
const pages = markdownFiles(wiki);
const entrypoints = ["README.md", "acp/README.md", "desktop/README.md", "external/pi-tools-suite/README.md",
  "scripts/session-revision-eval/README.md", "src/bundled-extensions/terminal-bell/README.md",
  "external/pi-tools-suite/src/async-subagents/core/owned-launch/README.md"]
  .map(path => resolve(root, path)).filter(path => existsSync(path));

for (const page of [...pages, ...entrypoints]) {
  graph.set(page, new Set());
  const source = prose(readFileSync(page, "utf8"));
  // Balanced parentheses cover authored Markdown destinations, including images.
  const links = /(!?)\[(?:[^\[\]\n]|\[[^\]\n]*\])*\]\(\s*(<[^>\n]+>|(?:[^\s()]|\([^()]*\))+)(?:\s+"[^"]*")?\s*\)/g;
  for (const match of source.matchAll(links)) checkDestination(page, match[2]!, match[1] === "!");
  const definitions = new Map([...source.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)/gm)]
    .map(match => [match[1]!.toLowerCase(), match[2]!]));
  for (const match of source.matchAll(/(!?)\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const destination = definitions.get((match[3] || match[2])!.toLowerCase());
    if (destination) checkDestination(page, destination, match[1] === "!");
    else failures.push(`${relative(root, page)}: undefined reference [${match[3] || match[2]}]`);
  }
  for (const match of source.matchAll(/<(?:a|img)\b[^>]*\b(?:href|src)=["']([^"']+)["']/g)) {
    checkDestination(page, match[1]!, match[0].startsWith("<img"));
  }
}

const reachable = new Set<string>();
const pending = [resolve(wiki, "index.md")];
while (pending.length) {
  const page = pending.pop()!;
  if (reachable.has(page)) continue;
  reachable.add(page);
  pending.push(...(graph.get(page) ?? []));
}
for (const page of pages) {
  if (!reachable.has(page)) failures.push(`${relative(root, page)}: not reachable from wiki/index.md`);
}

console.log(`Wiki: ${pages.length} pages; ${checkedLinks} local links; ${checkedImages} images; ${failures.length} errors`);
for (const failure of failures) console.error(failure);
process.exitCode = failures.length ? 1 : 0;
