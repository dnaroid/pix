import { createDiagnosticLogger } from "./diagnostic-logging";

export type ModelSelectionCounts = Readonly<Record<string, number>>;
const diagnostics = createDiagnosticLogger(() => ({ workspace: "" }));

function storageKey(workspace: string): string {
  return `pix.desktop.modelSelectionFrequency.${encodeURIComponent(workspace)}`;
}

export function readModelSelectionCounts(workspace: string): ModelSelectionCounts {
  if (!workspace) return {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey(workspace)) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([ref, count]) =>
      ref.length > 0 && Number.isSafeInteger(count) && (count as number) > 0,
    ));
  } catch (error) {
    diagnostics.report(error);
    return {};
  }
}

export function recordModelSelection(workspace: string, modelRef: string): void {
  if (!workspace || !modelRef) return;
  const counts = readModelSelectionCounts(workspace);
  const count = Object.hasOwn(counts, modelRef) ? counts[modelRef]! : 0;
  try {
    localStorage.setItem(storageKey(workspace), JSON.stringify({
      ...counts, [modelRef]: Math.min(count + 1, Number.MAX_SAFE_INTEGER),
    }));
  } catch (error) {
    diagnostics.report(error);
  }
}

export function modelsBySelectionFrequency<T extends { ref: string }>(
  models: readonly T[], counts: ModelSelectionCounts,
): T[] {
  const count = (ref: string): number => Object.hasOwn(counts, ref) ? counts[ref]! : 0;
  return [...models].sort((a, b) => count(b.ref) - count(a.ref));
}
