export function createSessionRuntimeConfigState() {
  let changingConfig = $state<Map<string, string>>(new Map());
  const configChangeGenerations = new Map<string, number>();

  function configChangeInProgress(sessionId: string): boolean {
    return changingConfig.has(sessionId);
  }

  function beginConfigChange(sessionId: string, value: string): number {
    const generation = (configChangeGenerations.get(sessionId) ?? 0) + 1;
    configChangeGenerations.set(sessionId, generation);
    const next = new Map(changingConfig);
    next.set(sessionId, value);
    changingConfig = next;
    return generation;
  }

  function endConfigChange(sessionId: string, generation: number): void {
    if (configChangeGenerations.get(sessionId) !== generation) return;
    const next = new Map(changingConfig);
    next.delete(sessionId);
    changingConfig = next;
  }

  function configChangeIsCurrent(sessionId: string, generation: number): boolean {
    return configChangeGenerations.get(sessionId) === generation;
  }

  function forget(sessionId: string): void {
    configChangeGenerations.set(sessionId, (configChangeGenerations.get(sessionId) ?? 0) + 1);
    if (!changingConfig.has(sessionId)) return;
    const next = new Map(changingConfig);
    next.delete(sessionId);
    changingConfig = next;
  }

  function reset(): void {
    configChangeGenerations.clear();
    changingConfig = new Map();
  }

  return {
    get changingConfig() { return changingConfig; },
    configChangeInProgress,
    beginConfigChange,
    endConfigChange,
    configChangeIsCurrent,
    forget,
    reset,
  };
}

export type SessionRuntimeConfigState = ReturnType<typeof createSessionRuntimeConfigState>;
