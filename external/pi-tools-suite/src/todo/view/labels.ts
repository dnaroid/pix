import type { TaskStatus } from "../tool/types.js";

const STATUS_LABELS: Record<TaskStatus, string> = {
	pending: "pending",
	in_progress: "in progress",
	deferred: "deferred",
	completed: "completed",
	deleted: "deleted",
};

export function formatStatusLabel(status: TaskStatus): string {
	return STATUS_LABELS[status];
}
