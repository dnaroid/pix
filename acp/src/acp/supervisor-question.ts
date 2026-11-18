import type { SupervisorQuestionSelection } from "./supervisor-contract.js";
import type { PixQuestion } from "./ui-request-bridge.js";

/** Build the same text-only version 1 answer that Desktop returns to the editor. */
export function encodeSupervisorQuestionAnswer(questions: readonly PixQuestion[], selections: readonly SupervisorQuestionSelection[]): string {
	const byId = new Map(selections.map((selection) => [selection.id, selection]));
	if (byId.size !== selections.length || selections.length !== questions.length) {
		throw new Error("Provide exactly one selection for each question id from supervisor read");
	}
	const ordered = questions.map((question) => {
		const selection = byId.get(question.id);
		if (!selection) throw new Error("Provide exactly one selection for each question id from supervisor read");
		const invalid = () => new Error(`Invalid selection for question ${question.id}; check the option values and selection limits from supervisor read`);
		const values = question.choices.map(({ value }) => value);
		if ("choiceValues" in selection) {
			const chosen = new Set(selection.choiceValues);
			const count = chosen.size + (selection.customText === undefined ? 0 : 1);
			if (!question.multiple || chosen.size !== selection.choiceValues.length || [...chosen].some((value) => !values.includes(value))
				|| count < (question.minSelections ?? 1) || count > (question.maxSelections ?? values.length + 1)) throw invalid();
			return { ...selection, choiceValues: values.filter((value) => chosen.has(value)) };
		}
		if (question.multiple || ("choiceValue" in selection && !values.includes(selection.choiceValue))) throw invalid();
		return selection;
	});
	return JSON.stringify({ version: 1, selections: ordered });
}
