<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import X from "@lucide/svelte/icons/x";
  import type { KnowledgeCitation, KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
  import type { ProjectKnowledgeJob } from "../app/project-knowledge-queue.svelte";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import { iconButtonClass } from "../lib/icon-button";
  import WikiConsistencyReport from "./WikiConsistencyReport.svelte";

  let { workspace, jobs = [], onCancel, onDismiss, onOpenFile, onOpenCitation, onResolve, canOpenSources = true, resolving = false }: {
    workspace: string;
    jobs?: readonly ProjectKnowledgeJob[];
    onCancel?: (id: number) => void;
    onDismiss?: (id: number) => void;
    onOpenFile: (path: string, range?: ProjectFileLineRange) => void;
    onOpenCitation?: (citation: KnowledgeCitation, language?: KnowledgeReportLanguage) => void | Promise<void>;
    onResolve?: (job: ProjectKnowledgeJob) => void | Promise<void>;
    canOpenSources?: boolean;
    resolving?: boolean;
  } = $props();

  let expanded = $state(false);
  let selectedId = $state<number | undefined>();
  let header = $state<HTMLButtonElement>();
  export function open(): void { expanded = true; header?.focus(); }
  const projectJobs = $derived(jobs.filter((job) => job.workspace === workspace));
  const displayed = $derived([...projectJobs].reverse());
  const pending = $derived(projectJobs.filter((job) => job.state === "queued" || job.state === "running").length);
  const russian = $derived([...projectJobs].reverse().find((job) => job.result)?.result?.reportLanguage === "ru");
  const actionClass = "rounded-sm px-2 py-1 text-xs font-medium hover:bg-panel-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  function label(job: ProjectKnowledgeJob): string {
    const ru = job.result?.reportLanguage === "ru" || (!job.result && russian);
    if (job.state === "queued") return ru ? "В очереди" : "Queued";
    if (job.state === "running") return ru ? "Проверяем…" : "Checking…";
    if (job.state === "failed") return ru ? "Ошибка" : "Failed";
    if (job.state === "cancelled") return ru ? "Отменено" : "Cancelled";
    if (job.result?.status === "conflicts") return ru ? "Противоречия" : "Conflicts";
    if (job.result?.status === "incomplete") return ru ? "Неполная проверка" : "Incomplete";
    return ru ? "Проверено" : "Checked";
  }

  function dismiss(id: number): void {
    if (selectedId === id) selectedId = undefined;
    header?.focus();
    onDismiss?.(id);
  }
</script>

<section class="min-h-0 shrink-0 border-t border-border" aria-label={russian ? "Проверки Wiki" : "Wiki checks"} data-wiki-check-queue>
  <button
    bind:this={header}
    type="button"
    class="flex h-8 w-full items-center gap-1.5 px-3 text-left text-xs font-medium text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    aria-expanded={expanded}
    onclick={() => expanded = !expanded}
  >
    <ChevronRight class={["h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none", expanded ? "rotate-90" : "rotate-0"]} aria-hidden="true" />
    <span class="min-w-0 flex-1">{russian ? "Проверки" : "Checks"}</span>
    <span class="tabular-nums" aria-live="polite">{pending ? `${pending} ${russian ? "в работе" : "pending"} · ` : ""}{projectJobs.length}</span>
  </button>
  {#if expanded}
    <div class="max-h-96 overflow-auto border-t border-border">
      {#if !projectJobs.length}
        <p class="px-3 py-2 text-xs text-muted-foreground">{russian ? "Запустите проверку на странице Wiki. Отчёт останется здесь после перехода на другую страницу." : "Start a check from a Wiki page. Its report stays here when you navigate away."}</p>
      {/if}
      {#each displayed as job (job.id)}
        {@const active = job.state === "queued" || job.state === "running"}
        {@const selected = selectedId === job.id}
        {@const ru = job.result?.reportLanguage === "ru" || (!job.result && russian)}
        <div class="border-b border-border last:border-b-0" data-wiki-check-job={job.id}>
          <div class="flex min-h-9 items-center gap-1 px-2">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-1 text-left text-xs hover:bg-panel-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              aria-expanded={selected}
              title={job.path}
              onclick={() => selectedId = selected ? undefined : job.id}
            >
              <ChevronRight class={["h-3 w-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", selected ? "rotate-90" : "rotate-0"]} aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{job.path}</span>
              <span class={["shrink-0", job.result?.status === "conflicts" ? "text-tool-error" : job.result?.status === "clear" && !job.error ? "text-tool-success" : job.state === "failed" || job.result?.status === "incomplete" ? "text-tool-warning" : "text-muted-foreground"]}>{label(job)}</span>
            </button>
            {#if active}
              <button type="button" class={actionClass} onclick={() => onCancel?.(job.id)}>{ru ? "Отменить" : "Cancel"}</button>
            {:else}
              <button type="button" class={iconButtonClass("sm", "panel")} title={ru ? "Удалить отчёт из списка" : "Dismiss report from the list"} aria-label={`${ru ? "Удалить отчёт" : "Dismiss report"}: ${job.path}`} onclick={() => dismiss(job.id)}><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
            {/if}
          </div>
          {#if selected}
            <div class="px-3 pb-2 text-xs text-muted-foreground">
              <p>{job.persistStamp
                ? ru ? "Отчёт относится к сохранённой версии на момент запуска. Файл мог измениться после проверки." : "This report covers the saved version captured when the check started. The file may have changed since."
                : ru ? "Отчёт относится к снимку текста на момент запуска. Эта проверка не сохраняла документ." : "This report covers the text snapshot captured when the check started. This check did not save the document."}</p>
              {#if job.error}<p class="mt-1 text-tool-warning">{job.error}</p>{/if}
              <button type="button" class={[actionClass, "mt-1"]} onclick={() => onOpenFile(job.path)}>{ru ? "Открыть страницу" : "Open page"}</button>
            </div>
            {#if job.result}
              <WikiConsistencyReport
                result={job.result}
                compact={true}
                {canOpenSources}
                {onOpenCitation}
                onResolve={onResolve ? () => onResolve?.(job) : undefined}
                {resolving}
                onCancel={() => selectedId = undefined}
                onSaveAnyway={() => {}}
                onOpenSource={onOpenFile}
              />
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>
