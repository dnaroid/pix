import * as PiTui from "@earendil-works/pi-tui";

import { CUSTOM_ANSWER_LABEL } from "./contract";
import type {
	NormalizedQuestion,
	QuestionInputHandlingResult,
	QuestionMouseEvent,
	QuestionSelection,
	QuestionUiContext,
} from "./types";

type QuestionMode = "choices" | "custom" | "review";
type AddLine = (text: string) => number;
type AddWrappedLine = (text: string) => number;
type TabTarget = number | "review";

type ClickZone =
	| { kind: "tab"; target: TabTarget; row: number; startColumn: number; endColumn: number }
	| { kind: "choice"; index: number; row: number; startColumn: number; endColumn: number }
	| { kind: "custom"; row: number; startColumn: number; endColumn: number }
	| { kind: "review"; index: number; row: number; startColumn: number; endColumn: number }
	| { kind: "submit"; row: number; startColumn: number; endColumn: number };

function isKey(data: string, key: string): boolean {
	const tui = PiTui as unknown as { Key?: Record<string, string | ((value: string) => string)>; matchesKey?: (data: string, key: string) => boolean };
	const keyValue = key === "shift+enter" && typeof tui.Key?.shift === "function" ? tui.Key.shift("enter") : tui.Key?.[key];
	if (typeof keyValue === "string" && tui.matchesKey?.(data, keyValue)) return true;
	if (data === key) return true;
	const aliases: Record<string, string[]> = {
		up: ["\u001b[A"],
		down: ["\u001b[B"],
		right: ["\u001b[C"],
		left: ["\u001b[D"],
		enter: ["\r", "\n"],
		escape: ["\u001b"],
		backspace: ["\u007f", "\b"],
		tab: ["\t"],
		"shift+tab": ["\u001b[Z"],
		"shift+enter": ["\u001b[13;2u", "\u001b[13;2~", "\u001b[27;2;13~", "\u001b\r", "\u001b\n"],
	};
	return aliases[key]?.includes(data) ?? false;
}

function truncateLine(line: string, width: number, suffix = "…"): string {
	const truncateToWidth = (PiTui as unknown as { truncateToWidth?: (line: string, width: number, suffix?: string) => string }).truncateToWidth;
	if (truncateToWidth) return truncateToWidth(line, width, suffix);
	if (line.length <= width) return line;
	return `${line.slice(0, Math.max(0, width - suffix.length))}${suffix}`;
}

function wrapLine(line: string, width: number): string[] {
	const wrapTextWithAnsi = (PiTui as unknown as { wrapTextWithAnsi?: (line: string, width: number) => string[] }).wrapTextWithAnsi;
	if (wrapTextWithAnsi) return wrapTextWithAnsi(line, width);
	if (width <= 0) return [""];
	if (line.length <= width) return [line];
	const words = line.split(/(\s+)/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current.length + word.length <= width) {
			current += word;
			continue;
		}
		if (current.trimEnd()) lines.push(current.trimEnd());
		if (word.length > width) {
			for (let index = 0; index < word.length; index += width) lines.push(word.slice(index, index + width));
			current = "";
		} else {
			current = word.trimStart();
		}
	}
	if (current.trimEnd()) lines.push(current.trimEnd());
	return lines.length > 0 ? lines : [""];
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function visibleLength(text: string): number {
	return stripAnsi(text).length;
}

type QuestionStyleOptions = {
	foreground?: string;
	background?: string;
	bold?: boolean;
};

type QuestionThemeLike = {
	fg(color: string, text: string): string;
	bg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
	style?: (text: string, options: QuestionStyleOptions) => string;
};

function styleText(theme: QuestionThemeLike, text: string, options: QuestionStyleOptions): string {
	if (theme.style) return theme.style(text, options);
	let styled = text;
	if (options.foreground) styled = theme.fg(options.foreground, styled);
	if (options.background && theme.bg) styled = theme.bg(options.background, styled);
	if (options.bold && theme.bold) styled = theme.bold(styled);
	return styled;
}

function padVisible(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleLength(text)))}`;
}

function paintLine(theme: QuestionThemeLike, text: string, width: number, options: QuestionStyleOptions = {}): string {
	return styleText(theme, padVisible(truncateLine(text, width), width), options);
}

function formatHeader(title: string, width: number): string {
	const titleText = title.replace(/\s+/g, " ").trim() || "Question";
	return truncateLine(titleText, width);
}

function clampIndex(index: number, length: number): number {
	return Math.max(0, Math.min(Math.max(0, length - 1), index));
}

export async function runQuestionnaire(questions: NormalizedQuestion[], ctx: QuestionUiContext): Promise<QuestionSelection[] | null> {
	return ctx.ui.custom<QuestionSelection[] | null>((tui, theme, _keybindings, done) => {
		const selections = new Map<string, QuestionSelection>();
		const customDrafts = new Map<string, string>();
		const reviewSubmitIndex = questions.length;
		const pixCapabilities = (tui as unknown as { pix?: { delegatedEditorInput?: boolean; inputMouse?: boolean } }).pix;
		const usesSharedEditor = Boolean(pixCapabilities?.delegatedEditorInput && ctx.ui.setEditorText && ctx.ui.getEditorText);
		let questionIndex = 0;
		let selectedChoiceIndex = 0;
		let selectedReviewIndex = reviewSubmitIndex;
		let mode: QuestionMode = "choices";
		let customError: string | undefined;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		let clickZones: ClickZone[] = [];

		function currentQuestion(): NormalizedQuestion {
			return questions[questionIndex]!;
		}

		function invalidateCache(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		}

		function refresh(): void {
			invalidateCache();
			tui.requestRender();
		}

		function customAnswerIndex(question = currentQuestion()): number {
			return question.choices.length;
		}

		function sharedEditorText(): string {
			if (usesSharedEditor) return ctx.ui.getEditorText?.() ?? "";
			return customDrafts.get(currentQuestion().id) ?? "";
		}

		function setSharedEditorText(text: string): void {
			customDrafts.set(currentQuestion().id, text);
			if (usesSharedEditor) ctx.ui.setEditorText?.(text);
		}

		function clearSharedEditorText(): void {
			if (usesSharedEditor) ctx.ui.setEditorText?.("");
		}

		function captureCustomDraft(): void {
			if (mode !== "custom") return;
			customDrafts.set(currentQuestion().id, sharedEditorText());
		}

		function getCompleteSelections(): QuestionSelection[] | undefined {
			const orderedSelections: QuestionSelection[] = [];
			for (const question of questions) {
				const selection = selections.get(question.id);
				if (!selection) return undefined;
				orderedSelections.push(selection);
			}
			return orderedSelections;
		}

		function firstUnansweredIndex(): number {
			return questions.findIndex((question) => !selections.has(question.id));
		}

		function submitCompleteSelections(): void {
			const completeSelections = getCompleteSelections();
			if (completeSelections) done(completeSelections);
		}

		function submitOrAnswerRemaining(): void {
			const firstUnanswered = firstUnansweredIndex();
			if (firstUnanswered !== -1) {
				moveToQuestion(firstUnanswered);
				return;
			}
			submitCompleteSelections();
		}

		function formatReviewAnswerLabel(question: NormalizedQuestion, selection: QuestionSelection): string {
			if ("customText" in selection) return `${CUSTOM_ANSWER_LABEL}: ${selection.customText}`;
			return question.choices.find((choice) => choice.value === selection.choiceValue)?.label ?? "Unknown";
		}

		function selectionIndexForQuestion(question: NormalizedQuestion): number {
			const selection = selections.get(question.id);
			if (!selection) return 0;
			if ("customText" in selection) return customAnswerIndex(question);
			const choiceIndex = question.choices.findIndex((choice) => choice.value === selection.choiceValue);
			return choiceIndex === -1 ? 0 : choiceIndex;
		}

		function syncChoiceSelection(): void {
			selectedChoiceIndex = selectionIndexForQuestion(currentQuestion());
		}

		function renderSelectableLine(add: AddLine, selected: boolean, text: string, zone: Omit<ClickZone, "row" | "startColumn" | "endColumn">, width: number, foreground = "text"): void {
			const marker = selected ? "›" : " ";
			const line = ` ${marker} ${text}`;
			const row = add(selected
				? paintLine(theme, line, width, { foreground: "selectedText", background: "selectedBg", bold: true })
				: paintLine(theme, line, width, { foreground }));
			clickZones.push({ ...zone, row, startColumn: 1, endColumn: width + 1 } as ClickZone);
		}

		function renderMutedLine(add: AddLine, text: string, width: number): void {
			add(paintLine(theme, text, width, { foreground: "muted" }));
		}

		function moveToQuestion(index: number): void {
			captureCustomDraft();
			clearSharedEditorText();
			questionIndex = clampIndex(index, questions.length);
			mode = "choices";
			customError = undefined;
			syncChoiceSelection();
			refresh();
		}

		function goBack(): void {
			if (mode === "custom") {
				captureCustomDraft();
				clearSharedEditorText();
				mode = "choices";
				customError = undefined;
				syncChoiceSelection();
				refresh();
				return;
			}
			if (mode === "review") {
				moveToQuestion(questions.length - 1);
				return;
			}
			if (questionIndex > 0) moveToQuestion(questionIndex - 1);
			else done(null);
		}

		function showReview(): void {
			captureCustomDraft();
			clearSharedEditorText();
			mode = "review";
			const firstUnanswered = firstUnansweredIndex();
			selectedReviewIndex = firstUnanswered === -1 ? reviewSubmitIndex : firstUnanswered;
			refresh();
		}

		function advanceAfterAnswer(): void {
			if (!pixCapabilities?.delegatedEditorInput && questions.length === 1) {
				submitCompleteSelections();
				return;
			}
			if (questionIndex < questions.length - 1) {
				moveToQuestion(questionIndex + 1);
				return;
			}
			showReview();
		}

		function enterCustomMode(): void {
			const question = currentQuestion();
			const existing = selections.get(question.id);
			const prefill = existing && "customText" in existing ? existing.customText : customDrafts.get(question.id) ?? "";
			mode = "custom";
			selectedChoiceIndex = customAnswerIndex(question);
			customError = undefined;
			setSharedEditorText(prefill);
			refresh();
		}

		function selectChoice(index: number): void {
			const question = currentQuestion();
			const choice = question.choices[index];
			if (choice) {
				selections.set(question.id, { id: question.id, choiceValue: choice.value });
				customDrafts.delete(question.id);
				clearSharedEditorText();
				advanceAfterAnswer();
				return;
			}
			if (index === question.choices.length) enterCustomMode();
		}

		function submitCustomAnswer(): void {
			const text = sharedEditorText();
			const trimmed = text.trim();
			if (!trimmed) {
				customError = "Custom Answer cannot be empty.";
				refresh();
				return;
			}
			const question = currentQuestion();
			selections.set(question.id, { id: question.id, customText: trimmed });
			customDrafts.delete(question.id);
			clearSharedEditorText();
			advanceAfterAnswer();
		}

		function updateChoiceSelection(index: number): void {
			const maxIndex = customAnswerIndex();
			const nextIndex = Math.max(0, Math.min(maxIndex, index));
			if (nextIndex === selectedChoiceIndex) return;
			selectedChoiceIndex = nextIndex;
			refresh();
		}

		function updateReviewSelection(index: number): void {
			const nextIndex = Math.max(0, Math.min(reviewSubmitIndex, index));
			if (nextIndex === selectedReviewIndex) return;
			selectedReviewIndex = nextIndex;
			refresh();
		}

		function activeTab(): TabTarget {
			return mode === "review" ? "review" : questionIndex;
		}

		function activateTab(target: TabTarget): void {
			if (target === "review") showReview();
			else moveToQuestion(target);
		}

		function moveTab(delta: number): void {
			const targets: TabTarget[] = [...questions.map((_, index) => index), "review"];
			const current = activeTab();
			const currentIndex = Math.max(0, targets.findIndex((target) => target === current));
			const nextIndex = (currentIndex + delta + targets.length) % targets.length;
			activateTab(targets[nextIndex]!);
		}

		function handleTabNavigation(data: string): boolean {
			if (isKey(data, "tab")) {
				moveTab(1);
				return true;
			}
			if (isKey(data, "shift+tab")) {
				moveTab(-1);
				return true;
			}
			return false;
		}

		function handleCustomInput(data: string): QuestionInputHandlingResult | void {
			if (handleTabNavigation(data)) return;
			if (isKey(data, "escape")) {
				goBack();
				return;
			}
			if (isKey(data, "shift+enter")) {
				if (usesSharedEditor) return { consume: false };
				setSharedEditorText(`${sharedEditorText()}\n`);
				customError = undefined;
				refresh();
				return;
			}
			if (isKey(data, "enter")) {
				submitCustomAnswer();
				return;
			}

			if (usesSharedEditor) return { consume: false };
			if (isKey(data, "backspace")) {
				setSharedEditorText(sharedEditorText().slice(0, -1));
				customError = undefined;
				refresh();
				return;
			}
			if (data >= " ") {
				setSharedEditorText(sharedEditorText() + data);
				customError = undefined;
				refresh();
			}
		}

		function handleReviewInput(data: string): void {
			if (handleTabNavigation(data)) return;
			if (isKey(data, "left")) {
				moveTab(-1);
				return;
			}
			if (isKey(data, "right")) {
				moveTab(1);
				return;
			}
			if (isKey(data, "up")) {
				updateReviewSelection(selectedReviewIndex - 1);
				return;
			}
			if (isKey(data, "down")) {
				updateReviewSelection(selectedReviewIndex + 1);
				return;
			}
			if (data === "s") {
				submitOrAnswerRemaining();
				return;
			}
			if (data === "b" || isKey(data, "backspace")) {
				goBack();
				return;
			}
			if (isKey(data, "enter")) {
				if (selectedReviewIndex === reviewSubmitIndex) {
					submitOrAnswerRemaining();
					return;
				}
				moveToQuestion(selectedReviewIndex);
				return;
			}
			if (isKey(data, "escape")) done(null);
		}

		function handleChoiceInput(data: string): void {
			if (handleTabNavigation(data)) return;
			if (isKey(data, "left")) {
				moveTab(-1);
				return;
			}
			if (isKey(data, "right")) {
				moveTab(1);
				return;
			}
			if (isKey(data, "up")) {
				updateChoiceSelection(selectedChoiceIndex - 1);
				return;
			}
			if (isKey(data, "down")) {
				updateChoiceSelection(selectedChoiceIndex + 1);
				return;
			}
			if (data === "b" || isKey(data, "backspace")) {
				goBack();
				return;
			}
			if (isKey(data, "enter")) {
				selectChoice(selectedChoiceIndex);
				return;
			}
			if (isKey(data, "escape")) {
				done(null);
				return;
			}
			if (/^[1-9]$/.test(data)) {
				const index = Number(data) - 1;
				if (index <= customAnswerIndex()) selectChoice(index);
			}
		}

		function renderHeader(add: AddLine, title: string, width: number): void {
			add(paintLine(theme, formatHeader(title, width), width, { foreground: "accent", background: "headerBg", bold: true }));
		}

		function renderTabs(add: AddLine, width: number): void {
			let plain = " ";
			const styledParts: string[] = [" "];
			const zones: Array<Omit<Extract<ClickZone, { kind: "tab" }>, "row">> = [];
			const active = activeTab();

			for (let index = 0; index < questions.length; index += 1) {
				const answered = selections.has(questions[index]!.id);
				const label = ` ${index + 1}${answered ? "✓" : "·"} `;
				const startColumn = visibleLength(plain) + 1;
				plain += label;
				const endColumn = visibleLength(plain) + 1;
				styledParts.push(active === index
					? styleText(theme, label, { foreground: "selectedText", background: "selectedBg", bold: true })
					: theme.fg(answered ? "success" : "muted", label));
				zones.push({ kind: "tab", target: index, startColumn, endColumn });
				plain += " ";
				styledParts.push(" ");
			}

			const reviewComplete = Boolean(getCompleteSelections());
			const reviewLabel = " Review ";
			const reviewStart = visibleLength(plain) + 1;
			plain += reviewLabel;
			const reviewEnd = visibleLength(plain) + 1;
			styledParts.push(active === "review"
				? styleText(theme, reviewLabel, { foreground: "selectedText", background: "selectedBg", bold: true })
				: theme.fg(reviewComplete ? "success" : "muted", reviewLabel));
			zones.push({ kind: "tab", target: "review", startColumn: reviewStart, endColumn: reviewEnd });

			const renderedRow = add(padVisible(styledParts.join(""), width));
			for (const zone of zones) {
				if (zone.startColumn <= width) clickZones.push({ ...zone, row: renderedRow, endColumn: Math.min(zone.endColumn, width + 1) });
			}
		}

		function renderSeparator(add: AddLine, width: number): void {
			add(paintLine(theme, "─".repeat(width), width, { foreground: "muted" }));
		}

		function renderReview(add: AddLine, addWrapped: AddWrappedLine, width: number): void {
			renderHeader(add, "Review answers", width);
			renderTabs(add, width);
			renderSeparator(add, width);
			questions.forEach((question, index) => {
				const answer = selections.get(question.id);
				const label = answer ? formatReviewAnswerLabel(question, answer) : "Unanswered";
				const status = answer ? "✓" : "·";
				renderSelectableLine(
					add,
					index === selectedReviewIndex,
					`${status} ${index + 1}. ${question.label}: ${label}`,
					{ kind: "review", index },
					width,
					answer ? "success" : "warning",
				);
			});

			const isComplete = Boolean(getCompleteSelections());
			renderSeparator(add, width);
			renderSelectableLine(add, selectedReviewIndex === reviewSubmitIndex, isComplete ? "Submit answers" : "Answer remaining questions", { kind: "submit" }, width, isComplete ? "success" : "warning");
		}

		function renderQuestion(add: AddLine, addWrapped: AddWrappedLine, width: number): void {
			const question = currentQuestion();
			renderHeader(add, `${questionIndex + 1}/${questions.length} ${question.label}`, width);
			renderTabs(add, width);
			renderSeparator(add, width);
			addWrapped(theme.fg("info", ` ${question.prompt}`));
			question.choices.forEach((choice, index) => {
				renderSelectableLine(add, mode === "choices" && index === selectedChoiceIndex, `${index + 1}. ${choice.label}`, { kind: "choice", index }, width, "warning");
				if (choice.description) renderMutedLine(add, `    ${choice.description}`, width);
			});
			renderSelectableLine(add, mode === "choices" && selectedChoiceIndex === customAnswerIndex(), `${question.choices.length + 1}. ${CUSTOM_ANSWER_LABEL}`, { kind: "custom" }, width, "warning");
			if (mode === "custom") {
				if (!usesSharedEditor) {
					(sharedEditorText() || " ").split("\n").forEach((line) => addWrapped(theme.fg("text", ` ${line}`)));
				}
				if (customError && !sharedEditorText().trim()) addWrapped(theme.fg("warning", ` ${customError}`));
			}
		}

		function handleMouse(event: QuestionMouseEvent): boolean {
			if (!event.released) return false;
			const zone = clickZones.find((candidate) => (
				candidate.row === event.localRow
				&& event.localColumn >= candidate.startColumn
				&& event.localColumn < candidate.endColumn
			));
			if (!zone) return false;

			switch (zone.kind) {
				case "tab":
					activateTab(zone.target);
					return true;
				case "choice":
					selectedChoiceIndex = zone.index;
					selectChoice(zone.index);
					return true;
				case "custom":
					enterCustomMode();
					return true;
				case "review":
					moveToQuestion(zone.index);
					return true;
				case "submit":
					submitOrAnswerRemaining();
					return true;
			}
		}

		return {
			handleInput(data: string): void | QuestionInputHandlingResult {
				switch (mode) {
					case "custom":
						return handleCustomInput(data);
					case "review":
						handleReviewInput(data);
						return;
					case "choices":
						handleChoiceInput(data);
				}
			},
			handleMouse,
			usesEditor() {
				return mode === "custom" && usesSharedEditor;
			},
			invalidate() {
				invalidateCache();
			},
			render(width: number) {
				if (cachedLines && cachedWidth === width) return cachedLines;
				const safeWidth = Math.max(1, width);
				const lines: string[] = [];
				clickZones = [];
				const add = (text: string) => {
					const row = lines.length;
					lines.push(text);
					return row;
				};
				const addWrapped = (text: string) => {
					const row = lines.length;
					const wrapped = wrapLine(text, safeWidth);
					for (const line of wrapped.length > 0 ? wrapped : [""]) lines.push(truncateLine(line, safeWidth));
					return row;
				};
				if (mode === "review") renderReview(add, addWrapped, safeWidth);
				else renderQuestion(add, addWrapped, safeWidth);
				cachedWidth = width;
				cachedLines = lines;
				return lines;
			},
		};
	});
}
