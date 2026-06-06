/**
 * Shared types for tool-call renderers.
 *
 * Inspired by src/tool-renderers/types.ts from the terminal pix but adapted
 * for React: instead of returning styled line ranges, each renderer returns
 * a React node to be mounted inside the tool body.
 */

import type { ReactNode } from "react";

export type ToolStatus = "running" | "done" | "error";

export interface ToolRenderProps {
  /** Raw tool name as reported by the SDK (e.g. "Bash", "Read", "repo_search"). */
  name: string;
  /** Parsed args object/string/undefined. */
  args: unknown;
  /** Raw result/output text. */
  result: unknown;
  /** Current execution state. */
  status: ToolStatus;
  /** True when the SDK reported the tool call as failed. */
  isError: boolean;
  /** Workspace cwd (for relative path display). Optional. */
  cwd?: string;
}

export interface ToolRenderer {
  /** Stable id (used as React key, debugging). */
  id: string;
  /** Header summary shown next to the tool name (e.g. file path or command). */
  summarize: (props: ToolRenderProps) => string;
  /** Body content shown when the card is expanded. */
  render: (props: ToolRenderProps) => ReactNode;
}

export type ToolRegistryEntry = {
  /** Match by exact tool name (case-insensitive). */
  exact?: Record<string, ToolRenderer>;
  /** Match by name prefix. */
  prefix?: Array<{ prefix: string; renderer: ToolRenderer }>;
};
