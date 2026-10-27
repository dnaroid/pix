import type { ProjectTreeEntry } from "./project-tree";

// Keep aligned with the native project cleanup allowlists. Disposable containers
// are canonical storage locations, but intentionally receive no visual accent.
const durableDirectories = new Set([
  "agents", "file-history", "plans", "search", "skills", "task-attachments", "workspace.jsonc.lock",
]);
const canonicalFiles = new Set([
  "AGENTS.md", "agent-model-overrides.json", "pi-tools-suite.jsonc",
  "pix-desktop.jsonc", "pix.jsonc", "project-icon.gif", "project-icon.jpg",
  "project-icon.png", "project-icon.svg", "project-icon.webp", "qa_auth.jsonc",
  "registry.json", "registry.jsonc", "registry-project-key", "tasks.sqlite",
  "tasks.sqlite-wal", "tasks.sqlite-shm", "tasks.sqlite-journal", "todo-plan.json",
  "workspace.jsonc",
]);

export function projectEntryEmphasis(entry: ProjectTreeEntry): string | undefined {
  if (entry.path === ".pi" && entry.kind === "directory") return "Pix project configuration";
  if (entry.path === "AGENTS.md" && entry.kind === "file") return "Project agent instructions";
  const parts = entry.path.split("/");
  const name = parts[1];
  if (parts.length !== 2 || parts[0] !== ".pi" || !name) return undefined;
  const canonical = entry.kind === "directory"
    ? durableDirectories.has(name)
    : canonicalFiles.has(name);
  return canonical ? "Canonical Pix project state" : undefined;
}
