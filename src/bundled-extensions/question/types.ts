export interface QuestionChoiceInput {
	value: string;
	label: string;
	description?: string;
}

export interface QuestionInput {
	id: string;
	label: string;
	prompt: string;
	choices: QuestionChoiceInput[];
	multiple?: boolean;
	minSelections?: number;
	maxSelections?: number;
}

export interface QuestionToolInput {
	questions: QuestionInput[];
}

export interface NormalizedQuestionChoice {
	value: string;
	label: string;
	description?: string;
}

export interface NormalizedQuestion {
	id: string;
	label: string;
	prompt: string;
	choices: NormalizedQuestionChoice[];
	multiple?: true;
	minSelections?: number;
	maxSelections?: number;
}

export interface PredefinedQuestionSelection {
	id: string;
	choiceValue: string;
}

export interface CustomQuestionSelection {
	id: string;
	customText: string;
	images?: QuestionImageContent[];
}

export interface MultipleQuestionSelection {
	id: string;
	choiceValues: string[];
	customText?: string;
	images?: QuestionImageContent[];
}

export type QuestionSelection = PredefinedQuestionSelection | CustomQuestionSelection | MultipleQuestionSelection;

export interface QuestionAnswerSelection {
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
	imageCount?: number;
}

export interface SingleQuestionAnswer extends QuestionAnswerSelection {
	id: string;
}

export interface MultipleQuestionAnswer {
	id: string;
	multiple: true;
	selections: QuestionAnswerSelection[];
}

export type QuestionAnswer = SingleQuestionAnswer | MultipleQuestionAnswer;

export interface SuccessfulQuestionResult {
	answers: QuestionAnswer[];
	canceled: false;
}

export interface CanceledQuestionResult {
	answers: [];
	canceled: true;
	reason: "ui_unavailable" | "user_canceled";
	fallbackPrompt?: string;
}

export type QuestionResultDetails = SuccessfulQuestionResult | CanceledQuestionResult;

export interface TextContent {
	type: "text";
	text: string;
}

export interface QuestionImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface QuestionEditorSnapshot {
	text: string;
	images: QuestionImageContent[];
}

export interface QuestionToolResult {
	content: Array<TextContent | QuestionImageContent>;
	details: QuestionResultDetails;
}

export interface QuestionUiContext {
	hasUI?: boolean;
	ui: {
		custom<T>(factory: (tui: QuestionTui, theme: QuestionTheme, keybindings: unknown, done: (value: T) => void) => QuestionComponent): Promise<T | undefined>;
		editor?(title: string, prefill?: string): Promise<string | undefined>;
		setEditorText?(text: string): void;
		getEditorText?(): string;
		setEditorSnapshot?(snapshot: QuestionEditorSnapshot): void;
		getEditorSnapshot?(): QuestionEditorSnapshot;
		notify?(message: string, level: "info" | "warning" | "error"): void;
	};
}

export interface QuestionTui {
	requestRender(): void;
}

export interface QuestionThemeStyleOptions {
	foreground?: string;
	background?: string;
	bold?: boolean;
}

export interface QuestionTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
	style?(text: string, options: QuestionThemeStyleOptions): string;
}

export interface QuestionMouseEvent {
	button: number;
	x: number;
	y: number;
	released: boolean;
	localRow: number;
	localColumn: number;
	width: number;
}

export interface QuestionInputHandlingResult {
	consume?: boolean;
	data?: string;
}

export interface QuestionComponent {
	handleInput(data: string): void | QuestionInputHandlingResult;
	handleMouse?(event: QuestionMouseEvent): boolean | void;
	usesEditor?(): boolean;
	invalidate(): void;
	render(width: number): string[];
}
