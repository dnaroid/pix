/** Editor schema for Registry synchronization provenance, not Registry configuration. */
import { Type } from "typebox";

const Artifact = Type.Union(["tasks", "plans", "workspace"].map((value) => Type.Literal(value)));
const Origin = {
	remote: Type.String({ description: "Registry Git remote." }),
	branch: Type.String(),
	revision: Type.String({ description: "Last synchronized Git revision." }),
	hash: Type.String({ description: "Last synchronized content hash." }),
};

export const RegistryProvenanceSchema = Type.Object({
	$schema: Type.Optional(Type.String({ description: "JSON Schema URL for editor validation and autocomplete." })),
	version: Type.Literal(1),
	resources: Type.Record(Type.String(), Type.Object({
		type: Type.Union([Type.Literal("skill"), Type.Literal("agent")]),
		name: Type.String(),
		...Origin,
		publicationScope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
		projectKey: Type.Optional(Type.String()),
	})),
	projectResources: Type.Optional(Type.Object(Object.fromEntries(
		["tasks", "plans", "workspace"].map((key) => [key, Type.Optional(Type.Object({
			artifact: Artifact,
			projectKey: Type.String(),
			...Origin,
		}))]),
	))),
}, {
	$id: "https://unpkg.com/pi-ui-extend/schemas/registry.json",
	$schema: "https://json-schema.org/draft-07/schema#",
	title: "Pix Registry Provenance",
	description: "Synchronization provenance in .pi/registry.jsonc. Managed by Registry operations; remote configuration lives in pi-tools-suite.jsonc.",
	additionalProperties: true,
});
