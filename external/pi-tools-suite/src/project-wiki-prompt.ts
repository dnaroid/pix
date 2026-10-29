import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getProjectWikiConfig, type ProjectWikiConfig } from "./lib/project-wiki.js";
import { diagnosticErrorType, suiteDiagnostics } from "./lib/suite-diagnostics.js";

const SECTION = "project_wiki_guidance";
const OWNED_BLOCK = /(?:\n\n)?<project_wiki_guidance>\n[\s\S]*?\n<\/project_wiki_guidance>/gu;

function missing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function contained(root: string, target: string): boolean {
	const path = relative(root, target);
	return path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

async function initializedWiki(cwd: string): Promise<ProjectWikiConfig | undefined> {
	const root = await realpath(cwd);
	let source: string | undefined;
	try {
		const configPath = await realpath(join(root, ".pi", "workspace.jsonc"));
		if (!contained(root, configPath)) throw new Error("Wiki configuration is outside the project.");
		source = await readFile(configPath, "utf8");
	} catch (error) {
		if (!missing(error)) throw error;
	}
	const config = getProjectWikiConfig(source);
	try {
		const indexPath = await realpath(join(root, config.indexPath));
		if (!contained(root, indexPath)) throw new Error("Wiki index is outside the project.");
		return (await stat(indexPath)).isFile() ? config : undefined;
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
}

// JSON string literals keep paths data, including XML delimiters in filenames.
function quotedPath(path: string): string {
	return JSON.stringify(path).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function guidance(config: ProjectWikiConfig): string {
	return `The Wiki is this project's knowledge base. Save and maintain durable project knowledge, documentation and specifications in ${quotedPath(config.path + "/")} (index: ${quotedPath(config.indexPath)}). Follow the existing Wiki structure and keep documentation and index links current. Honor explicit user-requested locations and required fixed-path files.`;
}

/** Re-evaluate the current project on every run, including an already-open session. */
export function registerProjectWikiPrompt(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		const cwd = event.systemPromptOptions.cwd;
		let hint: string | undefined;
		try {
			const config = await initializedWiki(cwd);
			if (config) hint = guidance(config);
		} catch (error) {
			if (!missing(error)) suiteDiagnostics.report("warn", "project-wiki", "prompt-read-failed", cwd, {
				errorType: diagnosticErrorType(error),
			});
		}

		delete event.systemPromptOptions.sections[SECTION];
		if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
			const base = event.systemPrompt.replace(OWNED_BLOCK, "");
			const prompt = hint ? `${base}\n\n<${SECTION}>\n${hint}\n</${SECTION}>` : base;
			if (prompt !== event.systemPrompt) return { systemPrompt: prompt };
		} else if (hint) {
			event.systemPromptOptions.sections[SECTION] = hint;
		}
	});
}
