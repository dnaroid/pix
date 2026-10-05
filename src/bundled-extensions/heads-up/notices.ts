import { MAX_HEADS_UP_NOTICES, type HeadsUpFeedback, type HeadsUpNotice } from "./contract.js";
import { HeadsUpFeedbackMemory, issueKey } from "./feedback.js";

/** Bounded runtime-only cards, selection and topic memory. No timers or inference. */
export class HeadsUpNotices {
	private cards: HeadsUpNotice[] = [];
	private selectedId: string | undefined;
	readonly memory = new HeadsUpFeedbackMemory();
	/** Changes to membership/content, not navigation; protects in-flight assessments. */
	version = 0;
	get all(): readonly HeadsUpNotice[] { return this.cards; }
	get previous(): readonly string[] { return this.memory.records.map((entry) => `${entry.outcome}: ${entry.title}. ${entry.consequence}`); }
	get current(): HeadsUpNotice | null { return this.cards.find((card) => card.id === this.selectedId) ?? this.cards[0] ?? null; }
	private replace(cards: HeadsUpNotice[]): void {
		const index = Math.max(0, this.cards.findIndex((card) => card.id === this.selectedId));
		if (!cards.some((card) => card.id === this.selectedId)) {
			const neighbors = [...this.cards.slice(index + 1), ...this.cards.slice(0, index).reverse()];
			this.selectedId = neighbors.find((old) => cards.some((card) => card.id === old.id))?.id ?? cards[0]?.id;
		}
		this.cards = cards; this.version++;
	}
	clear(): void { if (this.cards.length) this.replace([]); }
	expire(now: number): boolean {
		const live = this.cards.filter((card) => card.expiresAt > now);
		if (live.length === this.cards.length) return false;
		this.replace(live); return true;
	}
	select(direction: -1 | 1): boolean {
		if (this.cards.length < 2) return false;
		const index = this.cards.findIndex((card) => card.id === this.current?.id);
		this.selectedId = this.cards[(index + direction + this.cards.length) % this.cards.length]!.id;
		return true;
	}
	feedback(id: string, feedback: HeadsUpFeedback): boolean {
		const card = this.cards.find((card) => card.id === id);
		if (!card) return false;
		this.memory.feedback(card, feedback);
		this.replace(this.cards.filter((card) => card.id !== id)); return true;
	}
	/** The model returns the entire supported set. Existing cards retain order/TTL. */
	apply(candidates: readonly HeadsUpNotice[]): void {
		const byId = new Map(this.cards.map((card) => [card.id, card]));
		const byKey = new Map(this.cards.map((card) => [issueKey(card), card]));
		const accepted = new Map<string, HeadsUpNotice>();
		const keys = new Set<string>();
		// Process retained identities before discoveries, so duplicates cannot replace them.
		for (const candidate of [...candidates.filter((card) => byId.has(card.id)), ...candidates.filter((card) => !byId.has(card.id))]) {
			const key = issueKey(candidate);
			const existing = byId.get(candidate.id) ?? byKey.get(key);
			if (keys.has(key) || (existing && accepted.has(existing.id)) || (!existing && this.memory.isRepeat(candidate))) continue;
			keys.add(key);
			const card = existing ? { ...candidate, id: existing.id, createdAt: existing.createdAt, expiresAt: existing.expiresAt } : candidate;
			accepted.set(card.id, card);
			if (!existing) this.memory.shown(card);
			else this.memory.remember(card, "shown");
		}
		const retained = this.cards.flatMap((card) => accepted.has(card.id) ? [accepted.get(card.id)!] : []);
		this.replace([...retained, ...[...accepted.values()].filter((card) => !byId.has(card.id))].slice(0, MAX_HEADS_UP_NOTICES));
	}
}
