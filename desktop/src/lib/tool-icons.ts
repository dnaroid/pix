import Brain from "@lucide/svelte/icons/brain";
import FileText from "@lucide/svelte/icons/file-text";
import FilePen from "@lucide/svelte/icons/file-pen";
import FilePlus from "@lucide/svelte/icons/file-plus";
import FolderSearch from "@lucide/svelte/icons/folder-search";
import Terminal from "@lucide/svelte/icons/terminal";
import Search from "@lucide/svelte/icons/search";
import ScanSearch from "@lucide/svelte/icons/scan-search";
import Replace from "@lucide/svelte/icons/replace";
import CodeXml from "@lucide/svelte/icons/code-xml";
import Globe from "@lucide/svelte/icons/globe";
import BookOpen from "@lucide/svelte/icons/book-open";
import GraduationCap from "@lucide/svelte/icons/graduation-cap";
import ListChecks from "@lucide/svelte/icons/list-checks";
import ListTodo from "@lucide/svelte/icons/list-todo";
import Bot from "@lucide/svelte/icons/bot";
import MessageCircleQuestion from "@lucide/svelte/icons/message-circle-question-mark";
import Minimize2 from "@lucide/svelte/icons/minimize-2";
import Workflow from "@lucide/svelte/icons/workflow";
import History from "@lucide/svelte/icons/history";
import PanelsTopLeft from "@lucide/svelte/icons/panels-top-left";
import Wrench from "@lucide/svelte/icons/wrench";

/** Current tools and synthetic activity labels only; unknown/retired tools use Wrench. */
const iconGroups: readonly (readonly [readonly string[], typeof Brain])[] = [
  [["thinking"], Brain],
  [["read"], FileText],
  [["apply_patch", "edit"], FilePen],
  [["write"], FilePlus],
  [["ast_apply"], Replace],
  [["shell", "bash"], Terminal],
  [["project_search", "grep"], Search],
  [["glob"], FolderSearch],
  [["ast_grep"], ScanSearch],
  [["codemode"], CodeXml],
  [["web_search"], Globe],
  [["web_fetch"], BookOpen],
  [["skill"], GraduationCap],
  [["todo"], ListChecks],
  [["project_tasks"], ListTodo],
  [["subagents"], Bot],
  [["question"], MessageCircleQuestion],
  [["compress"], Minimize2],
  [["parallel"], Workflow],
  [["session"], History],
  [["pix_html_guide"], PanelsTopLeft],
];
const iconsByName = new Map(iconGroups.flatMap(([names, icon]) => names.map((name) => [name, icon] as const)));

/** Labels contain only lightweight metadata, never tool inputs/results. */
export function activityIcon(label: string): typeof Brain {
  const name = label.startsWith("skill ") ? "skill" : label.split(/[.:/]/u).at(-1)?.toLowerCase();
  return iconsByName.get(name ?? "") ?? Wrench;
}
