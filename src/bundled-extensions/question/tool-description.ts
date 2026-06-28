export const QUESTION_TOOL_DESCRIPTION = {
	name: "question",
	label: "Question",
	description: "Ask the user one to five structured questions, each with two to five choices plus an implicit custom answer path.",
	promptSnippet: "Gather structured user feedback with predefined choices and an always-available custom answer path.",
	promptGuidelines: [
		"Use question to gather feedback, choose alternatives, confirm direction, or resolve ambiguity when you can provide at least two meaningful choices.",
		"question accepts 1–5 questions with 2–5 choices each and an implicit custom answer path; avoid it for purely open-ended input or when normal conversation is clearer.",
	],
};
