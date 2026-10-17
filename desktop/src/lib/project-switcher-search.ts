import { fuzzySearch } from "./fuzzy";
import { projectName } from "./recent-projects";

/** Match project names and full paths; preserve recency when the query is empty. */
export function searchRecentProjects(projects: readonly string[], query: string): string[] {
  return fuzzySearch(projects.map((path) => ({
    value: path,
    label: projectName(path),
    aliases: [path],
  })), query).map((match) => match.value);
}
