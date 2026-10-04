import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HeadsUpSnapshot } from "./contract.js";

export function presentHeadsUp(ctx: ExtensionContext, state: HeadsUpSnapshot, expanded: boolean): void {
	if (ctx.mode === "rpc" && process.env.PIX_ACP_SESSION_STATE_BRIDGE === "1") {
		ctx.ui.setWidget("pix.session-state", ["heads-up", JSON.stringify(state)]);
		return;
	}
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	const note = state.notice;
	const cards = state.notices ?? (note ? [note] : []);
	const lines = note ? [
		`Heads up${cards.length > 1 ? ` · ${cards.findIndex((card) => card.id === note.id) + 1} / ${cards.length}` : ""} · ${note.title}`,
		note.consequence,
		...(expanded ? note.evidence.flatMap((entry) => [`[${entry.id}]`, ...entry.text.split("\n").slice(0, 4).map((line) => line.slice(0, 160))]) : []),
		"/heads-up explain · /heads-up discuss · /heads-up dismiss",
		...(cards.length > 1 ? ["/heads-up prev · /heads-up next"] : []),
	] : state.awaitingReview ? ["Heads up · Awaiting fresh review", "Previous findings are hidden until revalidated."] : undefined;
	ctx.ui.setWidget("heads-up", lines, { placement: "aboveEditor" });
}
