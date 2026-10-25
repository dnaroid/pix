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
	launchCommands: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ pattern: "\\S", description: "Stable launch command identifier." }),
		name: Type.String({ pattern: "\\S", description: "Display name." }),
		command: Type.String({ pattern: "\\S", description: "Shell command to run in the project." }),
	}))),
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
	description: "Project identity, launch commands and Desktop view state in .pi/workspace.jsonc. Unknown fields are preserved.",
	additionalProperties: true,
});
