export type FuzzyRange = {
	start: number;
	end: number;
};

export type FuzzySearchItem<T> = {
	value: T;
	label: string;
	aliases?: readonly string[];
	keywords?: readonly string[];
};

export type FuzzyMatch<T> = {
	value: T;
	label: string;
	matchedText: string;
	matchedRanges: readonly FuzzyRange[];
	score: number;
	rank: number;
};

export type FuzzySearchOptions = {
	limit?: number;
	includeEmptyQuery?: boolean;
	minScorePerCharacter?: number;
	preferKeyboardLayoutMatches?: boolean;
};

type FuzzyScore = {
	score: number;
	ranges: readonly FuzzyRange[];
};

type FuzzyQueryVariant = {
	query: string;
	penalty: number;
	keyboardLayout: boolean;
};

const KEYBOARD_LAYOUT_VARIANT_PENALTY = 2;

const RUSSIAN_TO_ENGLISH_KEYBOARD_LAYOUT: Readonly<Record<string, string>> = {
	й: "q",
	ц: "w",
	у: "e",
	к: "r",
	е: "t",
	н: "y",
	г: "u",
	ш: "i",
	щ: "o",
	з: "p",
	х: "[",
	ъ: "]",
	ф: "a",
	ы: "s",
	в: "d",
	а: "f",
	п: "g",
	р: "h",
	о: "j",
	л: "k",
	д: "l",
	ж: ";",
	э: "'",
	я: "z",
	ч: "x",
	с: "c",
	м: "v",
	и: "b",
	т: "n",
	ь: "m",
	б: ",",
	ю: ".",
	ё: "`",
};

const ENGLISH_TO_RUSSIAN_KEYBOARD_LAYOUT: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(RUSSIAN_TO_ENGLISH_KEYBOARD_LAYOUT).map(([russian, english]) => [english, russian]),
);

export function fuzzySearch<T>(
	items: readonly FuzzySearchItem<T>[],
	query: string,
	options: FuzzySearchOptions = {},
): FuzzyMatch<T>[] {
	const normalizedQuery = normalizeQuery(query);
	const queryVariants = getQueryVariants(normalizedQuery);
	const includeEmptyQuery = options.includeEmptyQuery ?? true;
	if (!includeEmptyQuery && normalizedQuery.length === 0) return [];

	type CandidateMatch = FuzzyMatch<T> & { keyboardLayout: boolean };
	const candidateMatches: CandidateMatch[] = [];
	items.forEach((item, rank) => {
		const texts = [item.label, ...(item.aliases ?? []), ...(item.keywords ?? [])];
		let best: (FuzzyScore & { text: string; keyboardLayout: boolean }) | undefined;

		for (const text of texts) {
			for (const queryVariant of queryVariants) {
				const score = scoreFuzzyMatch(queryVariant.query, text);
				if (!score) continue;

				const adjustedScore = score.score - queryVariant.penalty;
				if (!best || adjustedScore > best.score) {
					best = { ...score, score: adjustedScore, text, keyboardLayout: queryVariant.keyboardLayout };
				}
			}
		}

		if (!best) return;
		if (isBelowMinimumScore(best.score, normalizedQuery, options.minScorePerCharacter)) return;
		candidateMatches.push({
			value: item.value,
			label: item.label,
			matchedText: best.text,
			matchedRanges: best.ranges,
			score: best.score,
			rank,
			keyboardLayout: best.keyboardLayout,
		});
	});

	const matches = options.preferKeyboardLayoutMatches && shouldPreferKeyboardLayoutMatches(query) && candidateMatches.some((match) => match.keyboardLayout)
		? candidateMatches.filter((match) => match.keyboardLayout)
		: candidateMatches;

	matches.sort((left, right) => {
		const scoreDelta = right.score - left.score;
		if (scoreDelta !== 0) return scoreDelta;
		const rankDelta = left.rank - right.rank;
		if (rankDelta !== 0) return rankDelta;
		return left.label.localeCompare(right.label);
	});

	return (options.limit === undefined ? matches : matches.slice(0, options.limit)).map(({ keyboardLayout: _keyboardLayout, ...match }) => match);
}

function isBelowMinimumScore(score: number, normalizedQuery: string, minScorePerCharacter: number | undefined): boolean {
	if (minScorePerCharacter === undefined || normalizedQuery.length === 0) return false;
	return score < normalizedQuery.length * minScorePerCharacter;
}

function scoreFuzzyMatch(normalizedQuery: string, text: string): FuzzyScore | undefined {
	if (normalizedQuery.length === 0) {
		return { score: 0, ranges: [] };
	}

	const normalizedText = normalizeText(text);
	let searchStart = 0;
	let previousIndex = -1;
	let score = 0;
	const indices: number[] = [];

	for (const queryChar of normalizedQuery) {
		const index = normalizedText.indexOf(queryChar, searchStart);
		if (index === -1) return undefined;

		indices.push(index);
		score += scoreCharacter(text, index, previousIndex, indices.length - 1);
		previousIndex = index;
		searchStart = index + 1;
	}

	if (normalizedText === normalizedQuery) {
		score += 100;
	} else if (normalizedText.startsWith(normalizedQuery)) {
		score += 50;
	}

	score -= Math.max(0, text.length - normalizedQuery.length) * 0.01;
	return { score, ranges: indicesToRanges(indices) };
}

function scoreCharacter(text: string, index: number, previousIndex: number, queryIndex: number): number {
	let score = 10;

	if (index === queryIndex) score += 6;
	if (isWordStart(text, index)) score += 8;

	if (previousIndex >= 0) {
		const gap = index - previousIndex - 1;
		score += gap === 0 ? 12 : -Math.min(gap, 8);
	} else {
		score -= Math.min(index, 10);
	}

	return score;
}

function isWordStart(text: string, index: number): boolean {
	if (index <= 0) return true;

	const previous = text.charAt(index - 1);
	const current = text.charAt(index);
	return /[\s/_-]/.test(previous) || (/[a-z]/.test(previous) && /[A-Z]/.test(current));
}

function indicesToRanges(indices: readonly number[]): FuzzyRange[] {
	const ranges: FuzzyRange[] = [];
	let start: number | undefined;
	let previous: number | undefined;

	for (const index of indices) {
		if (start === undefined || previous === undefined || index !== previous + 1) {
			if (start !== undefined && previous !== undefined) ranges.push({ start, end: previous + 1 });
			start = index;
		}
		previous = index;
	}

	if (start !== undefined && previous !== undefined) ranges.push({ start, end: previous + 1 });
	return ranges;
}

function normalizeQuery(value: string): string {
	return value.trim().toLowerCase();
}

function normalizeText(value: string): string {
	return value.toLowerCase();
}

function getQueryVariants(normalizedQuery: string): FuzzyQueryVariant[] {
	const variants: FuzzyQueryVariant[] = [{ query: normalizedQuery, penalty: 0, keyboardLayout: false }];
	addKeyboardLayoutVariant(variants, normalizedQuery, RUSSIAN_TO_ENGLISH_KEYBOARD_LAYOUT);
	addKeyboardLayoutVariant(variants, normalizedQuery, ENGLISH_TO_RUSSIAN_KEYBOARD_LAYOUT);
	return variants;
}

function addKeyboardLayoutVariant(
	variants: FuzzyQueryVariant[],
	normalizedQuery: string,
	layout: Readonly<Record<string, string>>,
): void {
	const variant = remapKeyboardLayout(normalizedQuery, layout);
	if (variant === normalizedQuery || variants.some((existing) => existing.query === variant)) return;
	variants.push({ query: variant, penalty: KEYBOARD_LAYOUT_VARIANT_PENALTY, keyboardLayout: true });
}

function shouldPreferKeyboardLayoutMatches(query: string): boolean {
	const trimmed = query.trim();
	if (!trimmed) return false;
	if (/^[А-ЯЁ][а-яё]+$/u.test(trimmed)) return false;
	return /[А-ЯЁ]/u.test(trimmed);
}

function remapKeyboardLayout(value: string, layout: Readonly<Record<string, string>>): string {
	return Array.from(value, (char) => layout[char] ?? char).join("");
}
