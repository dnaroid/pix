import type { WallClock } from "../clock/wall-clock.js";
import type { PacketState, RehearsalNode } from "./rehearsal-node.js";

export interface PacketEdge {
  disposition: "deliver" | "observe" | "discard";
  route: string;
}

export interface PacketFoldInput {
  node: RehearsalNode;
  edge: PacketEdge;
  clock: WallClock;
}

export interface PacketFoldResult {
  actorId: string;
  route: string;
  sealed: boolean;
  state: PacketState;
}

export function foldPacketEdges(input: PacketFoldInput): PacketFoldResult {
  const current = input.node.state;
  const shouldAdvancePulse = input.node.intent !== "commit" && input.edge.disposition === "observe";

  return {
    actorId: input.node.actorId,
    route: input.edge.route,
    sealed: input.edge.disposition !== "discard",
    state: {
      ...current,
      markers: {
        ...current.markers,
        lastPulseAt: shouldAdvancePulse ? input.clock.iso() : current.markers.lastPulseAt,
        lastReminderTemplate: current.template ?? current.markers.lastReminderTemplate,
      },
    },
  };
}
