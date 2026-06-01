import type { TruncationResult } from "@earendil-works/pi-coding-agent";

export type AstGrepParamsType = {
	command?: "run" | "scan";
	pattern?: string;
	paths?: string[];
	path?: string;
	lang?: string;
	rewrite?: string;
	updateAll?: boolean;
	selector?: string;
	strictness?: "cst" | "smart" | "ast" | "relaxed" | "signature" | "template";
	debugQuery?: "pattern" | "ast" | "cst" | "sexp";
	config?: string;
	globs?: string[];
	threads?: number;
	inspect?: "nothing" | "summary" | "entity";
	maxResults?: number;
	context?: number;
	before?: number;
	after?: number;
	filesWithMatches?: boolean;
	json?: boolean;
	jsonStyle?: "pretty" | "stream" | "compact";
	follow?: boolean;
	noIgnore?: Array<"hidden" | "dot" | "exclude" | "global" | "parent" | "vcs">;
	rule?: string;
	inlineRules?: string;
	format?: "github" | "sarif";
	reportStyle?: "rich" | "medium" | "short";
	includeMetadata?: boolean;
	filter?: string;
	error?: string[];
	warning?: string[];
	info?: string[];
	hint?: string[];
	off?: string[];
};

export interface AstGrepDetails {
	command: string[];
	mode: "run" | "scan";
	cwd: string;
	pattern?: string;
	paths: string[];
	lang?: string;
	rewritePreview: boolean;
	mutated: boolean;
	changedFiles?: string[];
	matchCount: number;
	exitCode: number;
	stderr?: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}
