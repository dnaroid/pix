/** JSON Schema for project-scoped Desktop tasks stored in <cwd>/.pi/tasks.jsonc. */
import { Static, Type } from "typebox";

const TaskType = Type.Union([
	Type.Literal("bug"),
	Type.Literal("feature"),
	Type.Literal("improvement"),
]);

const TaskStatus = Type.Union([
	Type.Literal("backlog"),
	Type.Literal("todo"),
	Type.Literal("in-progress"),
	Type.Literal("done"),
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
		description: "Project-scoped task document stored in <cwd>/.pi/tasks.jsonc.",
		additionalProperties: false,
	},
);

export type ProjectTasksSchemaType = Static<typeof ProjectTasksSchema>;
