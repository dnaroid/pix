export interface DiagnosticLogRecord {
  v: 1;
  time: string;
  level: "debug" | "info" | "warn" | "error";
  source: "backend" | "acp" | "desktop";
  module: string;
  event: string;
  project: { name: string; path: string } | null;
  details?: unknown;
  sessionId?: string;
}
export interface DiagnosticLogEntry { id: string; record: DiagnosticLogRecord }
export interface DiagnosticLogSnapshot { entries: DiagnosticLogEntry[]; limited: boolean; skipped: number }
export interface DiagnosticLogState { snapshot: DiagnosticLogSnapshot | null; error: string | null; loading: boolean }

/** Single-flight polling. Stopping invalidates pending results without pretending IPC is cancellable. */
export function createDiagnosticLogMonitor(
  read: () => Promise<DiagnosticLogSnapshot>,
  publish: (state: DiagnosticLogState) => void,
  interval = 2000,
) {
  let active = false;
  let generation = 0;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state: DiagnosticLogState = { snapshot: null, error: null, loading: false };
  function update(next: Partial<DiagnosticLogState>): void { state = { ...state, ...next }; publish(state); }
  async function refresh(): Promise<void> {
    if (!active || pending) return;
    clearTimeout(timer);
    const ticket = generation;
    pending = true;
    update({ loading: true });
    try {
      const snapshot = await read();
      if (active && ticket === generation) update({ snapshot, error: null });
    } catch (error) {
      if (active && ticket === generation) update({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      pending = false;
      if (active && ticket === generation) update({ loading: false });
      if (active) timer = setTimeout(() => void refresh(), ticket === generation ? interval : 0);
    }
  }
  return {
    start(): void { if (!active) { active = true; generation++; void refresh(); } },
    stop(): void {
      active = false;
      generation++;
      clearTimeout(timer);
      if (state.loading) update({ loading: false });
    },
    discardSnapshot(): void {
      generation++;
      update({ snapshot: null, error: null, loading: false });
    },
    refresh,
  };
}

export function filterDiagnosticLogs(entries: readonly DiagnosticLogEntry[], filters: {
  level: string; source: string; query: string; project: string | null;
}): DiagnosticLogEntry[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return entries.filter(({ record }) =>
    (!filters.level || record.level === filters.level)
    && (!filters.source || record.source === filters.source)
    && (filters.project === null || record.project?.path === filters.project)
    && (!query || JSON.stringify(record).toLocaleLowerCase().includes(query)));
}
