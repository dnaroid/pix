export const QUESTION_TOOL_DESCRIPTION = {
	name: "question",
	label: "Question",
	description: "Ask the user one to five structured questions, each with two to five choices plus an implicit custom answer path.",
	promptSnippet: "Gather structured user feedback with predefined choices and an always-available custom answer path.",
	promptGuidelines: [
		"Use question when gathering user feedback, choosing between alternatives, confirming direction, or resolving ambiguity, as long as you can provide at least two meaningful choices.",
		"question accepts 1–5 questions; each question needs 2–5 meaningful choices and automatically includes a custom answer path.",
		"Do not use question when the user's input is purely open-ended or when a normal conversational reply is clearer.",
	],
};
