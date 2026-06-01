import { homedir } from "node:os";
import { basename, isAbsolute, relative, sep } from "node:path";

import { VERSION, type AgentSessionRuntime, type ResourceDiagnostic, type SourceInfo } from "@earendil-works/pi-coding-agent";

type StartupSection = {
	title: string;
	items: string[];
};

export function createStartupInfoMessage(runtime: AgentSessionRuntime): string {
	const sections = startupSections(runtime);
	return [
		formatModelLine(runtime),
		`pix · pi-sdk v${VERSION}`,
		"escape interrupt · ctrl+c/ctrl+d clear/exit · / commands",
		"",
		...sections.flatMap(formatSection),
	].join("\n").trimEnd();
}

export function isEmptyStartupSession(runtime: AgentSessionRuntime): boolean {
	return Array.isArray(runtime.session.messages) && runtime.session.messages.length === 0;
}

function startupSections(runtime: AgentSessionRuntime): StartupSection[] {
	const loader = runtime.session.resourceLoader;
	const context = loader.getAgentsFiles();
	const skills = loader.getSkills();
	const prompts = loader.getPrompts();
	const extensions = loader.getExtensions();
	const themes = loader.getThemes();
	const diagnostics = [
		...diagnosticLines("skills", skills.diagnostics),
		...diagnosticLines("prompts", prompts.diagnostics),
		...diagnosticLines("themes", themes.diagnostics),
		...extensions.errors.map((error) => `extensions: ${formatPath(error.path, runtime.cwd)} — ${error.error}`),
	];

	return [
		section("Context", context.agentsFiles.map((file) => formatPath(file.path, runtime.cwd))),
		section("Skills", skills.skills.map((skill) => skill.name)),
		section("Prompts", unique(runtime.session.promptTemplates.map((prompt) => prompt.name), prompts.prompts.map((prompt) => prompt.name))),
		section("Extensions", extensionLabels(extensions.extensions, runtime.cwd)),
		section("Themes", themes.themes.map((theme) => theme.name ?? sourcePathLabel(theme.sourcePath, theme.sourceInfo, runtime.cwd))),
		section("Diagnostics", diagnostics),
	].filter((item): item is StartupSection => item !== undefined);
}

function section(title: string, items: string[]): StartupSection | undefined {
	const filtered = items.map((item) => item.trim()).filter(Boolean);
	return filtered.length > 0 ? { title, items: filtered } : undefined;
}

function formatSection(sectionValue: StartupSection): string[] {
	return [`[${sectionValue.title}]`, `  ${sectionValue.items.join(", ")}`, ""];
}

function formatModelLine(runtime: AgentSessionRuntime): string {
	const scopedModels = runtime.session.scopedModels;
	if (scopedModels.length > 0) {
		return `Model scope: ${scopedModels.map((item) => modelLabel(item.model.id, item.thinkingLevel)).join(", ")}`;
	}

	const model = runtime.session.model;
	return model ? `Model: ${model.provider}/${modelLabel(model.id, runtime.session.thinkingLevel)}` : "Model: unavailable";
}

function modelLabel(modelId: string, thinkingLevel: string | undefined): string {
	return thinkingLevel === undefined || thinkingLevel === "off" ? modelId : `${modelId}:${thinkingLevel}`;
}

function diagnosticLines(kind: string, diagnostics: readonly ResourceDiagnostic[]): string[] {
	return diagnostics.map((diag) => `${kind}: [${diag.type}] ${diag.message}${diag.path ? ` (${diag.path})` : ""}`);
}

function sourcePathLabel(pathValue: string | undefined, sourceInfo: SourceInfo | undefined, cwd: string): string {
	if (pathValue) return formatPath(pathValue, cwd);
	return sourceInfo ? formatPath(sourceInfo.path, cwd) : "unknown";
}

function extensionLabels(extensions: readonly { path: string; sourceInfo?: SourceInfo }[], cwd: string): string[] {
	const localExtensions = extensions
		.map((extension) => ({
			...extension,
			segments: compactDisplayPathSegments(extension.path, cwd),
		}))
		.filter((extension) => !isPackageSource(extension.sourceInfo));

	return extensions.map((extension) => {
		if (isPackageSource(extension.sourceInfo)) {
			return packageExtensionLabel(extension.path, extension.sourceInfo, cwd);
		}

		const localIndex = localExtensions.findIndex((candidate) => candidate.path === extension.path);
		if (localIndex === -1) return compactPathLabel(extension.path, cwd);

		return compactNonPackageExtensionLabel(extension.path, localIndex, localExtensions, cwd);
	});
}

function isPackageSource(sourceInfo: SourceInfo | undefined): boolean {
	const source = sourceInfo?.source ?? "";
	return source.startsWith("npm:") || source.startsWith("git:");
}

function packageExtensionLabel(pathValue: string, sourceInfo: SourceInfo | undefined, cwd: string): string {
	const sourceLabel = packageSourceLabel(sourceInfo);
	if (!sourceLabel) return compactPathLabel(pathValue, cwd);

	const shortPath = shortPathForSource(pathValue, sourceInfo, cwd).replace(/\\/g, "/");
	const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
	const trimmedPath = packagePath.replace(/\/(index\.[cm]?[jt]s)$/u, "");
	if (!trimmedPath || trimmedPath === "." || /^index\.[cm]?[jt]s$/u.test(trimmedPath)) return sourceLabel;

	return `${sourceLabel}:${trimmedPath}`;
}

function packageSourceLabel(sourceInfo: SourceInfo | undefined): string {
	const source = sourceInfo?.source ?? "";
	if (source.startsWith("npm:")) return source.slice("npm:".length) || source;
	if (source.startsWith("git:")) {
		const normalized = source.slice("git:".length).replace(/\.git$/u, "");
		const match = normalized.match(/([^/:]+\/[^/]+)$/u);
		return match?.[1] ?? normalized ?? source;
	}
	return "";
}

function compactNonPackageExtensionLabel(
	pathValue: string,
	index: number,
	allPaths: Array<{ path: string; segments: string[] }>,
	cwd: string,
): string {
	const segments = allPaths[index]?.segments;
	if (!segments || segments.length === 0) return compactPathLabel(pathValue, cwd);

	for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
		const candidate = segments.slice(-segmentCount).join("/");
		const unique = allPaths.every((item, itemIndex) => {
			if (itemIndex === index) return true;
			return item.segments.slice(-segmentCount).join("/") !== candidate;
		});
		if (unique) return candidate;
	}

	return segments.join("/");
}

function compactDisplayPathSegments(pathValue: string, cwd: string): string[] {
	const segments = displayPath(pathValue, cwd)
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
	const lastSegment = segments.at(-1);
	if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
		segments.pop();
	}
	return segments;
}

function compactPathLabel(pathValue: string, cwd: string): string {
	const segments = compactDisplayPathSegments(pathValue, cwd);
	return segments.at(-1) ?? formatPath(pathValue, cwd);
}

function shortPathForSource(pathValue: string, sourceInfo: SourceInfo | undefined, cwd: string): string {
	const baseDir = sourceInfo?.baseDir;
	if (baseDir && isPackageSource(sourceInfo)) {
		const rel = relative(baseDir, pathValue);
		if (rel && rel !== "." && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	}
	return displayPath(pathValue, cwd);
}

function displayPath(pathValue: string, cwd: string): string {
	if (!isAbsolute(pathValue)) return pathValue;

	const rel = relative(cwd, pathValue);
	if (rel && rel !== "." && !rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
		return rel;
	}

	const home = homedir();
	return pathValue.startsWith(home) ? `~${pathValue.slice(home.length)}` : pathValue;
}

function formatPath(pathValue: string, cwd: string): string {
	if (!isAbsolute(pathValue)) return pathValue;

	const rel = relative(cwd, pathValue);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : basename(pathValue);
}

function unique(...groups: string[][]): string[] {
	const seen = new Set<string>();
	const values: string[] = [];
	for (const group of groups) {
		for (const item of group) {
			if (seen.has(item)) continue;
			seen.add(item);
			values.push(item);
		}
	}
	return values;
}
