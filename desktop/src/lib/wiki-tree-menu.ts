import type { KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
import type { ProjectExplorerMenuAction } from "./project-explorer-native-menu";
import { filterWikiFindings, type WikiFinding } from "./wiki-conflicts-index";

export function wikiTreeConflictsLabel(language?: KnowledgeReportLanguage): string {
  return language === "ru" ? "Разобрать противоречия" : "Review contradictions";
}

/** Language of the saved reports touching this page or folder, for the menu label. */
export function wikiBranchReportLanguage(findings: readonly WikiFinding[], branch: string): KnowledgeReportLanguage | undefined {
  return filterWikiFindings(findings, { branch }).find(finding => finding.reportLanguage)?.reportLanguage;
}

/** Context menu of a red Wiki tree row: open the Conflicts tab filtered to that branch. */
export function wikiTreeConflictMenuActions(
  branch: string,
  language: KnowledgeReportLanguage | undefined,
  open: (input: { readonly path: string }) => void,
): ProjectExplorerMenuAction[] {
  return [{ id: "wiki-conflicts", label: wikiTreeConflictsLabel(language), action: () => open({ path: branch }) }];
}
