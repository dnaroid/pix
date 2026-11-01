export const QUESTION_TOOL_DESCRIPTION = {
	name: "question",
	label: "Question",
	description: "Ask the user one to five structured single- or multi-select questions, each with two to five choices plus an implicit custom answer path.",
	promptSnippet: "Gather structured user feedback with predefined single- or multi-select choices and an always-available custom answer path.",
	promptGuidelines: [
		"Use question when you need the user's answer before you can continue: choose alternatives, confirm direction or a risky step, or resolve ambiguity, with at least two meaningful choices.",
		"Do not use question merely to offer optional follow-ups after finishing; end the turn instead (in Pix Desktop, with a pix-actions checklist).",
		"Every choice must include both value and label. Put per-choice explanations, including risks and tradeoffs, in choices[].description; do not replace question with JSON action menus or add a risk field.",
		"Put any needed context and explanation in the assistant message before calling question, without repeating the question or listing its choices there. Keep each tool prompt a short, self-contained question and supply the answer choices in the tool; do not copy the preceding explanation into the form. Always include the question prompt, not just choices.",
		"question accepts 1–5 questions with 2–5 choices each and an implicit custom answer path; set multiple: true with optional minSelections/maxSelections when several answers may apply.",
		"For multi-select questions, the custom answer can be combined with predefined choices and counts as one selection toward the limits.",
	],
};
