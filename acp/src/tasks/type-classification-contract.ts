/** Desktop-only Quick Add classifier. No task file, transcript or workspace data is sent to Jev. */
export const TASK_TYPE_CLASSIFY_METHOD = "pix/tasks/classify_type";
export const QUICK_TASK_MAX_LENGTH = 2_048;
export const QUICK_TASK_DEFAULT_TYPE = "feature" as const;
export const CLASSIFIABLE_TASK_TYPES = ["bug", "feature", "improvement", "idea"] as const;

export type ClassifiedTaskType = (typeof CLASSIFIABLE_TASK_TYPES)[number];

export interface TaskTypeClassifyRequest {
  readonly cwd: string;
  readonly text: string;
}

export interface TaskTypeClassifyResponse {
  readonly type: ClassifiedTaskType;
  /** True when Jev was unavailable, timed out, or produced an invalid result. */
  readonly fallback: boolean;
}

export function isClassifiedTaskType(value: unknown): value is ClassifiedTaskType {
  return typeof value === "string" && (CLASSIFIABLE_TASK_TYPES as readonly string[]).includes(value);
}
