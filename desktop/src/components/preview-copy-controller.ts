interface CopyState {
  status: string;
  pending: boolean;
}

export function createPreviewCopyController(
  state: CopyState,
  write: (text: string, isCurrent: () => boolean) => Promise<void>,
  report: (error: unknown) => void,
) {
  let generation = 0;

  function reset(): void {
    generation++;
    state.status = "";
    state.pending = false;
  }

  async function copy(text: string): Promise<void> {
    if (state.pending) return;
    const owner = generation;
    state.pending = true;
    state.status = "";
    try {
      await write(text, () => owner === generation);
      if (owner === generation) state.status = "Copied";
    } catch (error) {
      report(error);
      if (owner === generation) state.status = "Copy failed";
    } finally {
      if (owner === generation) state.pending = false;
    }
  }

  return { copy, reset, dispose: () => { generation++; } };
}
