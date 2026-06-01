export type PacketIntent = "commit" | "shadow" | "inspect";
export type TransitLane = "retention" | "billing" | "support";

export interface PacketState {
  template?: string;
  markers: {
    lastPulseAt?: string;
    lastInvoiceAt?: string;
    lastReminderTemplate?: string;
  };
}

export interface RehearsalNode {
  actorId: string;
  lane: TransitLane;
  intent: PacketIntent;
  state: PacketState;
}

export function makeRehearsalNode(input: RehearsalNode): RehearsalNode {
  return {
    ...input,
    state: {
      ...input.state,
      markers: { ...input.state.markers },
    },
  };
}
