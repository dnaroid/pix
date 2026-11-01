import Brain from "@lucide/svelte/icons/brain";
import FileText from "@lucide/svelte/icons/file-text";
import Image from "@lucide/svelte/icons/image";
import FilePen from "@lucide/svelte/icons/file-pen";
import FilePlus from "@lucide/svelte/icons/file-plus";
import FolderSearch from "@lucide/svelte/icons/folder-search";
import Terminal from "@lucide/svelte/icons/terminal";
import Logs from "@lucide/svelte/icons/logs";
import ListTree from "@lucide/svelte/icons/list-tree";
import OctagonX from "@lucide/svelte/icons/octagon-x";
import ScanEye from "@lucide/svelte/icons/scan-eye";
import Search from "@lucide/svelte/icons/search";
import ScanSearch from "@lucide/svelte/icons/scan-search";
import Replace from "@lucide/svelte/icons/replace";
import CodeXml from "@lucide/svelte/icons/code-xml";
import Globe from "@lucide/svelte/icons/globe";
import BookOpen from "@lucide/svelte/icons/book-open";
import BookAlert from "@lucide/svelte/icons/book-alert";
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
// When adding a tool, choose its identity icon here (including provider aliases)
// and cover it in the activity/status icon tests. Wrench is only a fallback.
const iconGroups: readonly (readonly [readonly string[], typeof Brain])[] = [
  [["thinking"], Brain],
  [["read"], FileText],
  [["apply_patch", "edit"], FilePen],
  [["write"], FilePlus],
  [["ast_apply"], Replace],
  [["shell", "bash"], Terminal],
  [["shell_output", "bashoutput"], Logs],
  [["shell_jobs"], ListTree],
  [["shell_kill", "killshell"], OctagonX],
  [["lookup"], ScanEye],
  [["project_search", "grep"], Search],
  [["glob"], FolderSearch],
  [["ast_grep"], ScanSearch],
  [["codemode"], CodeXml],
  [["web_search"], Globe],
  [["web_fetch"], BookOpen],
  [["wiki_conflicts"], BookAlert],
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
export function activityIcon(label: string, imageRead = false): typeof Brain {
  if (imageRead) return Image;
  const name = label.startsWith("skill ") ? "skill" : label.split(/[.:/]/u).at(-1)?.toLowerCase();
  return iconsByName.get(name ?? "") ?? Wrench;
}
