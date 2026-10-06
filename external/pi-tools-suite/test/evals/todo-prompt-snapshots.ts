import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export type TodoPromptVariant = "brief" | "strengthened";

// Exact pre-strengthening wording from the preceding prompt experiment.
const REPLACEMENTS = [
	{
		file: "src/tool-descriptions.ts",
		current: "Change description only when scope, criteria, blocker or next action changes, or the user explicitly requests a brief checkpoint. For blocked work, retain acceptance criteria and replace obsolete details with the current blocker and next action. ",
		previous: "",
	},
	{ file: "src/tool-descriptions.ts", current: "put test results and detailed evidence", previous: "put detailed evidence" },
	{
		file: "src/tool-descriptions.ts",
		current: "On completion, update status without expanding the description; normally send only action, id and status (or id and status per batch item).",
		previous: "On completion, update status without expanding the description into a results report.",
	},
	{
		file: "src/tool-descriptions.ts",
		current: " If the user asks to stop after creation, stop without cosmetic text updates or applying background results.",
		previous: "",
	},
	{
		file: "src/todo/tool/types.ts",
		current: "Omit when subject suffices. On update, change only for changed scope/criteria/blocker/next action or an explicitly requested brief checkpoint; normally omit on completion. No progress journals or results reports.",
		previous: "Omit when subject suffices; no progress journals or results reports.",
	},
] as const;

export function previousTodoPrompt(file: string, text: string): string {
	for (const replacement of REPLACEMENTS.filter((item) => item.file === file)) {
		if (text.split(replacement.current).length !== 2) throw new Error(`Expected exactly one current prompt fragment in ${file}: ${replacement.current}`);
		text = text.replace(replacement.current, replacement.previous);
	}
	return text;
}

/** Freeze both variants before paid calls; never edit the working source or live mirror. */
export function createTodoPromptSnapshots(packageRoot: string, outputDir: string): Record<TodoPromptVariant, string> {
	const snapshots = path.join(outputDir, "snapshots");
	if (fs.existsSync(snapshots)) throw new Error(`Snapshots already exist: ${snapshots}`);
	const strengthened = path.join(snapshots, "strengthened");
	const excluded = new Set(["node_modules", "test", ".pi", ".git", ".indexer-cli"]);
	fs.cpSync(packageRoot, strengthened, {
		recursive: true,
		filter: (source) => source !== outputDir && !path.relative(packageRoot, source).split(path.sep).some((part) => excluded.has(part)),
	});
	const brief = path.join(snapshots, "brief");
	fs.cpSync(strengthened, brief, { recursive: true });
	const manifest: Record<string, unknown> = {};
	for (const root of [brief, strengthened]) {
		fs.symlinkSync(path.join(packageRoot, "node_modules"), path.join(root, "node_modules"), "dir");
		const variant = path.basename(root);
		const prompts: Record<string, unknown> = {};
		for (const file of [...new Set(REPLACEMENTS.map((item) => item.file))]) {
			const target = path.join(root, file);
			let text = fs.readFileSync(target, "utf8");
			if (variant === "brief") {
				text = previousTodoPrompt(file, text);
				fs.writeFileSync(target, text);
			}
			prompts[file] = { sha256: createHash("sha256").update(text).digest("hex"), text };
		}
		manifest[variant] = prompts;
	}
	fs.writeFileSync(path.join(outputDir, "prompt-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
	return { brief: path.join(brief, "index.ts"), strengthened: path.join(strengthened, "index.ts") };
}
