export type SupervisionState = {
  readonly mode: "managed" | "manual" | undefined;
  readonly supervisorAvailable: boolean;
  readonly enabled: boolean;
};

export function supervisionActions({ mode, supervisorAvailable }: SupervisionState) {
  const actions: { supervised: boolean; label: string }[] = [];
  if (supervisorAvailable && mode !== "managed") {
    actions.push({ supervised: true, label: "Hand Over to Supervisor" });
  }
  if (mode !== undefined) {
    actions.push({ supervised: false, label: "Take Back from Supervisor" });
  }
  return actions;
}
