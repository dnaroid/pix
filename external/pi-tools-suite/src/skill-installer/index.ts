import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ignoreStaleExtensionContextError } from "../context-usage.js";

const INSTALL_COMMAND = "install-skill";
const EXPORT_COMMAND = "export-skill";
const LOCAL_SKILLS_DIR = join(homedir(), ".agents", "local_skills");
const SKILL_FILE = "SKILL.md";
const PROJECT_DIR = ".pi";
const PROJECT_SKILLS_SUBDIR = "skills";
const SKIP_NAMES = new Set([".DS_Store"]);
const DESC_MAX = 90;

type SkillEntry = {
	name: string;
	path: string;
	description: string;
};

/** Direction-aware transfer plan shared by install and export. */
type Transfer = {
	srcDir: string;
	destDir: string;
	/** Human label for the destination root (with trailing slash); name is appended per skill. */
	destRootLabel: string;
	commandName: string;
	direction: "install" | "export";
};

function localSkillsLabel(): string {
	const home = homedir();
	return LOCAL_SKILLS_DIR === home ? LOCAL_SKILLS_DIR : LOCAL_SKILLS_DIR.replace(home, "~");
}

function projectSkillsDir(ctx: ExtensionContext): string {
	return join(ctx.cwd, PROJECT_DIR, PROJECT_SKILLS_SUBDIR);
}

function projectSkillsLabel(ctx: ExtensionContext): string {
	return displayPath(ctx, projectSkillsDir(ctx));
}

function displayPath(ctx: ExtensionContext, absPath: string): string {
	const rel = relative(ctx.cwd, absPath);
	return rel && !rel.startsWith("..") ? rel : absPath;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else console.log(message);
}

function truncate(value: string, maxLength: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Extract the `description` scalar from SKILL.md YAML frontmatter. Returns "" when absent/unparseable. */
function parseFrontmatterDescription(content: string): string {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return "";
	const front = match[1] ?? "";
	const lines = front.split(/\r?\n/);
	const idx = lines.findIndex((line) => /^\s*description:\s*/.test(line));
	if (idx === -1) return "";
	const headerLine = lines[idx];
	if (!headerLine) return "";
	const after = headerLine.replace(/^\s*description:\s*/, "");

	// Folded/literal block scalar (>, >-, |, |-)
	if (/^[>|]/.test(after)) {
		const block: string[] = [];
		for (let i = idx + 1; i < lines.length; i += 1) {
			const line = lines[i] ?? "";
			if (line === "") {
				block.push(" ");
				continue;
			}
			if (/^\s+/.test(line)) {
				block.push(line.replace(/^\s+/, ""));
				continue;
			}
			break;
		}
		return block.join(" ").trim();
	}

	// Plain or quoted scalar
	let value = after.trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		value = value.slice(1, -1);
	}
	return value;
}

async function readSkillDescription(skillDir: string): Promise<string> {
	try {
		const content = await fs.readFile(join(skillDir, SKILL_FILE), "utf-8");
		return parseFrontmatterDescription(content);
	} catch {
		return "";
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

/** Scan a skills directory: every subdirectory that contains SKILL.md. Returns ENOENT as empty. */
async function scanSkills(dir: string): Promise<SkillEntry[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const skills: SkillEntry[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || SKIP_NAMES.has(entry.name)) continue;
		const skillPath = join(dir, entry.name);
		if (!(await pathExists(join(skillPath, SKILL_FILE)))) continue;
		skills.push({ name: entry.name, path: skillPath, description: await readSkillDescription(skillPath) });
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function listLocalSkills(): Promise<SkillEntry[]> {
	return scanSkills(LOCAL_SKILLS_DIR);
}

function listProjectSkills(ctx: ExtensionContext): Promise<SkillEntry[]> {
	return scanSkills(projectSkillsDir(ctx));
}

function skillLabel(skill: SkillEntry): string {
	const description = skill.description.replace(/\s+/g, " ").trim();
	return description ? `${skill.name} — ${truncate(description, DESC_MAX)}` : skill.name;
}

async function copySkill(source: string, dest: string): Promise<void> {
	await fs.mkdir(join(dest, ".."), { recursive: true });
	await fs.cp(source, dest, {
		recursive: true,
		filter: (src) => !SKIP_NAMES.has(basename(src)),
	});
}

/** Copy a skill folder from srcDir/name → destDir/name with overwrite-confirm (UI) / refuse (headless). */
async function transferSkill(ctx: ExtensionCommandContext, name: string, t: Transfer): Promise<void> {
	const src = join(t.srcDir, name);
	const dest = join(t.destDir, name);

	if (await pathExists(dest)) {
		if (!ctx.hasUI) {
			notify(ctx, `Skill "${name}" already exists at ${t.destRootLabel}${name}. Remove it first or run /${t.commandName} ${name} interactively to overwrite.`, "error");
			return;
		}
		let confirmed = false;
		try {
			confirmed = await ctx.ui.confirm("Skill already exists", `"${name}" already exists in ${t.destRootLabel}. Overwrite it?`);
		} catch (error) {
			ignoreStaleExtensionContextError(error);
			return;
		}
		if (!confirmed) {
			notify(ctx, `Cancelled. "${name}" left unchanged.`);
			return;
		}
		await fs.rm(dest, { recursive: true, force: true });
	}

	try {
		await copySkill(src, dest);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(ctx, `Failed to ${t.direction} skill "${name}": ${message}`, "error");
		return;
	}

	if (t.direction === "install") {
		notify(ctx, `Installed skill "${name}" → ${t.destRootLabel}${name}. Reloading to activate…`);
		try {
			await ctx.reload();
		} catch (error) {
			ignoreStaleExtensionContextError(error);
		}
		return;
	}

	notify(ctx, `Exported skill "${name}" → ${t.destRootLabel}${name}. Available for /install-skill in other projects.`);
}

function installTransfer(ctx: ExtensionCommandContext): Transfer {
	return {
		srcDir: LOCAL_SKILLS_DIR,
		destDir: projectSkillsDir(ctx),
		destRootLabel: `${projectSkillsLabel(ctx)}/`,
		commandName: INSTALL_COMMAND,
		direction: "install",
	};
}

function exportTransfer(ctx: ExtensionCommandContext): Transfer {
	return {
		srcDir: projectSkillsDir(ctx),
		destDir: LOCAL_SKILLS_DIR,
		destRootLabel: `${localSkillsLabel()}/`,
		commandName: EXPORT_COMMAND,
		direction: "export",
	};
}

// --- install ---

async function showInstallMenu(ctx: ExtensionCommandContext): Promise<void> {
	const skills = await listLocalSkills();
	if (skills.length === 0) {
		notify(ctx, `No skills found in ${localSkillsLabel()} (each skill is a folder containing ${SKILL_FILE}).`, "warning");
		return;
	}

	if (!ctx.hasUI) {
		notify(ctx, `Available skills in ${localSkillsLabel()}:\n${skills.map((s) => s.name).join("\n")}\n\nUse /${INSTALL_COMMAND} <name> to install one.`, "warning");
		return;
	}

	const t = installTransfer(ctx);
	const labels = skills.map(skillLabel);
	const labelToName = new Map(labels.map((label, index) => [label, skills[index]!.name]));
	let selected: string | undefined;
	try {
		selected = await ctx.ui.select(`Install skill into ${projectSkillsLabel(ctx)}/ (${localSkillsLabel()})`, labels);
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return;
	}
	if (!selected) return;

	const name = labelToName.get(selected);
	if (!name) return;
	await transferSkill(ctx, name, t);
}

async function installByName(ctx: ExtensionCommandContext, name: string): Promise<void> {
	const skills = await listLocalSkills();
	const match = skills.find((entry) => entry.name === name);
	if (!match) {
		const available = skills.length > 0 ? skills.map((s) => s.name).join(", ") : "(none)";
		notify(ctx, `No skill named "${name}" in ${localSkillsLabel()}. Available: ${available}`, "error");
		return;
	}
	await transferSkill(ctx, match.name, installTransfer(ctx));
}

// --- export ---

async function showExportMenu(ctx: ExtensionCommandContext): Promise<void> {
	const skills = await listProjectSkills(ctx);
	if (skills.length === 0) {
		notify(ctx, `No skills found in ${projectSkillsLabel(ctx)}/. Install one first with /${INSTALL_COMMAND}.`, "warning");
		return;
	}

	if (!ctx.hasUI) {
		notify(ctx, `Installed skills in ${projectSkillsLabel(ctx)}/:\n${skills.map((s) => s.name).join("\n")}\n\nUse /${EXPORT_COMMAND} <name> to export one to ${localSkillsLabel()}.`, "warning");
		return;
	}

	const t = exportTransfer(ctx);
	const labels = skills.map(skillLabel);
	const labelToName = new Map(labels.map((label, index) => [label, skills[index]!.name]));
	let selected: string | undefined;
	try {
		selected = await ctx.ui.select(`Export skill from ${projectSkillsLabel(ctx)}/ to ${localSkillsLabel()}`, labels);
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return;
	}
	if (!selected) return;

	const name = labelToName.get(selected);
	if (!name) return;
	await transferSkill(ctx, name, t);
}

async function exportByName(ctx: ExtensionCommandContext, name: string): Promise<void> {
	const skills = await listProjectSkills(ctx);
	const match = skills.find((entry) => entry.name === name);
	if (!match) {
		const available = skills.length > 0 ? skills.map((s) => s.name).join(", ") : "(none)";
		notify(ctx, `No skill named "${name}" in ${projectSkillsLabel(ctx)}/. Installed: ${available}`, "error");
		return;
	}
	await transferSkill(ctx, match.name, exportTransfer(ctx));
}

export default function skillInstaller(pi: ExtensionAPI): void {
	pi.registerCommand(INSTALL_COMMAND, {
		description: `Install a skill from ${localSkillsLabel()} into the current project's ${PROJECT_DIR}/${PROJECT_SKILLS_SUBDIR}`,
		handler: async (args: string, ctx) => {
			const name = args.trim();
			try {
				if (name) await installByName(ctx, name);
				else await showInstallMenu(ctx);
			} catch (error) {
				ignoreStaleExtensionContextError(error);
			}
		},
	});

	pi.registerCommand(EXPORT_COMMAND, {
		description: `Export a skill from the current project's ${PROJECT_DIR}/${PROJECT_SKILLS_SUBDIR} to ${localSkillsLabel()} for reuse in other projects`,
		handler: async (args: string, ctx) => {
			const name = args.trim();
			try {
				if (name) await exportByName(ctx, name);
				else await showExportMenu(ctx);
			} catch (error) {
				ignoreStaleExtensionContextError(error);
			}
		},
	});
}
