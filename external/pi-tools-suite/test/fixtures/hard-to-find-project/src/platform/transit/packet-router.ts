import type { PacketEdge } from "./packet-fold.js";
import type { RehearsalNode } from "./rehearsal-node.js";

export function routePacket(node: RehearsalNode): PacketEdge {
  if (node.lane === "billing") return { disposition: "deliver", route: "invoice" };
  if (node.intent === "inspect") return { disposition: "discard", route: "inspection" };
  return { disposition: "observe", route: `${node.lane}-nudge` };
}
