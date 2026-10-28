/** Editor schema for project-local `.pi/workspace.jsonc` settings. */
import { Type } from "typebox";

export const WorkspaceConfigSchema = Type.Object({
	$schema: Type.Optional(Type.String({ description: "JSON Schema URL for editor validation and autocomplete." })),
	search: Type.Optional(Type.Object({
		sources: Type.Optional(Type.Object(Object.fromEntries(
			["code", "knowledge", "sessions", "tasks", "commits"].map(source => [source, Type.Optional(Type.Boolean())]),
		), { additionalProperties: false, description: "Project search/index sources. Code defaults on; other project sources default off. Settings is global." })),
		revision: Type.Optional(Type.String({ maxLength: 128, description: "Search-only generation nonce managed by source selection writers." })),
	}, { additionalProperties: true })),
	color: Type.Optional(Type.String({
		pattern: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$",
		description: "Project identity color in hexadecimal notation; omit to use the automatic color.",
	})),
	icon: Type.Optional(Type.String({
		pattern: "^\\.pi/project-icon\\.(?:png|jpg|webp|gif|svg)$",
		description: "Project-relative path to the canonical project logo; omit to use initials.",
	})),

	wiki: Type.Optional(Type.Object({
		path: Type.Optional(Type.String({
			minLength: 1,
			pattern: "\\S",
			default: "wiki",
			description: "Project-relative Wiki folder. Parent traversal, absolute paths, Git metadata and disposable harness storage are not allowed. Defaults to wiki/.",
		})),
		index: Type.Optional(Type.String({
			minLength: 1,
			pattern: "\\.[mM][dD]$|\\.[mM][aA][rR][kK][dD][oO][wW][nN]$",
			default: "index.md",
			description: "Markdown home page relative to the Wiki folder. Nested paths are supported; parent traversal and absolute paths are not allowed. Defaults to index.md.",
		})),
	}, { additionalProperties: true, description: "Project Wiki documents and assets. Omitted settings use wiki/index.md." })),
	launchCommands: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ pattern: "\\S", description: "Stable launch command identifier." }),
		name: Type.String({ pattern: "\\S", description: "Display name." }),
		command: Type.String({ pattern: "\\S", description: "Shell command to run in the project." }),
	}))),
	recentCommandRuns: Type.Optional(Type.Record(Type.String({ pattern: "^(launch|package):.+$" }), Type.Integer({
		minimum: 0,
		maximum: Number.MAX_SAFE_INTEGER,
	}), { additionalProperties: false, description: "Last successful launch time (Unix milliseconds), keyed by launch:<command-id> or package:<script-name>. Updated automatically; not a run counter." })),
	projectExplorer: Type.Optional(Type.Object({
		expandedDirectories: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
			maxItems: 256,
			uniqueItems: true,
			description: "Expanded project-relative folder paths. The tree itself is not stored.",
		})),
	})),
	usagePanel: Type.Optional(Type.Object({
		providerOrder: Type.Optional(Type.Array(Type.String(), {
			description: "Last provider quota-family popularity order, restored before loading usage. Unknown ids are retained for compatibility.",
		})),
		collapsedSections: Type.Optional(Type.Array(Type.String(), {
			description: "Collapsed usage section ids: provider-limits, overview, activity, daily, models, sessions, cache. Unknown ids are retained for compatibility.",
		})),
	})),
}, {
	$id: "https://unpkg.com/pi-ui-extend/schemas/workspace.json",
	$schema: "https://json-schema.org/draft-07/schema#",
	title: "Pix Project Workspace",
	description: "Project identity, Wiki, launch commands and Desktop view state in .pi/workspace.jsonc. Unknown fields are preserved.",
	additionalProperties: true,
});
