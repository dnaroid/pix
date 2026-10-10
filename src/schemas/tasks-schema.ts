/** JSON Schema for project-scoped tasks stored as payloads in <cwd>/.pi/tasks.sqlite. */
import { Static, Type } from "typebox";

const TaskType = Type.Union([
	Type.Literal("bug"),
	Type.Literal("feature"),
	Type.Literal("improvement"),
	Type.Literal("idea"),
]);

const TaskStatus = Type.Union([
	Type.Literal("backlog"),
	Type.Literal("todo"),
	Type.Literal("in-progress"),
	Type.Literal("done"),
	Type.Literal("failed"),
]);

const TaskPriority = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("urgent"),
]);

const ProjectTask = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128, description: "Stable unique task id." }),
		title: Type.String({ maxLength: 200, description: "Short task title. May be empty when the task has description content." }),
		description: Type.Optional(Type.String({ maxLength: 10_000, description: "Optional detailed task description." })),
		type: TaskType,
		status: TaskStatus,
		priority: TaskPriority,
		sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: "Optional Pi session associated with this task." })),
		links: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 50, description: "Optional project-relative paths to files/artifacts or http(s) URLs." })),
		relatedTaskIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
			maxItems: 50,
			description: "Optional references to other existing project tasks; duplicates and self links are prohibited.",
		})),
		parentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128,
			description: "Optional id of a parent task in this project; cycles and dangling references are prohibited." })),
		epic: Type.Optional(Type.Boolean({ description: "Top-level epic marker (cannot be combined with parentId)." })),
		modelRef: Type.Optional(Type.String({ minLength: 3, maxLength: 256,
			pattern: "^[^\\s/]+/[^\\s/]+(?:/[^\\s]+)*(?::(?:off|minimal|low|medium|high|xhigh|max))?$",
			description: "Optional provider/model[:thinking] override for new task sessions." })),
		createdAt: Type.String({ format: "date-time", description: "RFC 3339 creation timestamp." }),
		updatedAt: Type.String({ format: "date-time", description: "RFC 3339 last-update timestamp." }),
	},
	{ additionalProperties: false },
);

export const ProjectTasksSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON Schema URL used by editors for validation and autocomplete." })),
		version: Type.Literal(1, { description: "Task document format version." }),
		tasks: Type.Array(ProjectTask, { maxItems: 10_000, description: "Project tasks. Task ids must be unique." }),
	},
	{
		$id: "https://unpkg.com/pi-ui-extend/schemas/tasks.json",
		$schema: "https://json-schema.org/draft-07/schema#",
		title: "Pix Project Tasks",
		description: "Project-scoped task view backed by <cwd>/.pi/tasks.sqlite.",
		additionalProperties: false,
	},
);

export type ProjectTasksSchemaType = Static<typeof ProjectTasksSchema>;
