import { createHash } from "node:crypto";
import type { HeadsUpFeedback, HeadsUpFeedbackRecord, HeadsUpFeedbackSummary, HeadsUpNotice } from "./contract.js";

function normalize(text: string): string { return text.toLowerCase().replace(/\s+/g, " ").trim(); }

/** Preserve path punctuation: src/a.ts and src/a-ts are different subjects. */
export function issueKey(notice: HeadsUpNotice): string {
	return notice.topic && notice.subject
		? JSON.stringify([normalize(notice.topic), notice.subject.trim()])
		: `legacy:${normalize(`${notice.title} ${notice.consequence}`).replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;
}

function evidenceKey(notice: HeadsUpNotice): string {
	// IDs may change on replay; equal bounded evidence text is not a new circumstance.
	const texts = [...new Set(notice.evidence.map((entry) => normalize(entry.text)))].sort();
	return createHash("sha256").update(JSON.stringify(texts)).digest("hex");
}

/** Bounded task memory plus session-local feedback counters. No I/O or inference. */
export class HeadsUpFeedbackMemory {
	private entries: { key: string; evidence: string; record: HeadsUpFeedbackRecord }[] = [];
	private counts: HeadsUpFeedbackSummary = { shown: 0, useful: 0, known: 0, irrelevant: 0, incorrect: 0, dismiss: 0 };
	private multiplier: 1 | 2 | 4 = 1;
	get records(): readonly HeadsUpFeedbackRecord[] { return this.entries.map((entry) => entry.record); }
	get summary(): HeadsUpFeedbackSummary { return { ...this.counts }; }
	get discoveryMultiplier(): 1 | 2 | 4 { return this.multiplier; }
	resetTask(): void { this.entries = []; }
	isRepeat(notice: HeadsUpNotice): boolean {
		const key = issueKey(notice);
		const evidence = evidenceKey(notice);
		return this.entries.some((entry) => entry.key === key && entry.evidence === evidence);
	}
	remember(notice: HeadsUpNotice, outcome: HeadsUpFeedbackRecord["outcome"]): void {
		const key = issueKey(notice);
		const evidence = evidenceKey(notice);
		const record: HeadsUpFeedbackRecord = {
			outcome, title: notice.title, consequence: notice.consequence,
			...(notice.topic && notice.subject ? { topic: notice.topic, subject: notice.subject } : {}),
			evidenceIds: notice.evidence.map((entry) => entry.id),
		};
		// Updating an active assessment doesn't overwrite an explicit prior verdict.
		const previous = this.entries.find((entry) => entry.key === key && entry.evidence === evidence);
		if (outcome === "shown" && previous && previous.record.outcome !== "shown") return;
		this.entries = [...this.entries.filter((entry) => entry !== previous), { key, evidence, record }].slice(-32);
	}
	shown(notice: HeadsUpNotice): void {
		this.counts = { ...this.counts, shown: this.counts.shown + 1 };
		this.remember(notice, "shown");
	}
	feedback(notice: HeadsUpNotice, outcome: HeadsUpFeedback): void {
		this.counts = { ...this.counts, [outcome]: this.counts[outcome] + 1 };
		if (outcome === "useful") this.multiplier = 1;
		else if (outcome === "irrelevant" || outcome === "incorrect") this.multiplier = this.multiplier === 1 ? 2 : 4;
		this.remember(notice, outcome);
	}
}
