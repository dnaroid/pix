import type {
	ImageClickTarget,
	RenderedLine,
	StatusCompactToolsTarget,
	StatusContextTarget,
	StatusDraftQueueTarget,
	StatusModelTarget,
	StatusModelUsageTarget,
	StatusPromptEnhancerTarget,
	StatusSessionTarget,
	StatusTerminalBellSoundTarget,
	StatusThinkingExpandTarget,
	StatusThinkingTarget,
	StatusUserJumpTarget,
	StatusVoiceLanguageTarget,
	StatusVoiceMicTarget,
	TabLineMouseTarget,
} from "../types.js";

export type StatusRenderHitMap = {
	row: number;
	text: string;
	modelTarget: StatusModelTarget | undefined;
	thinkingTarget: StatusThinkingTarget | undefined;
	contextTarget: StatusContextTarget | undefined;
	modelUsageTarget: StatusModelUsageTarget | undefined;
	draftQueueTarget: StatusDraftQueueTarget | undefined;
	userJumpTarget: StatusUserJumpTarget | undefined;
	thinkingExpandTarget: StatusThinkingExpandTarget | undefined;
	compactToolsTarget: StatusCompactToolsTarget | undefined;
	terminalBellSoundTarget: StatusTerminalBellSoundTarget | undefined;
	sessionTarget: StatusSessionTarget | undefined;
	promptEnhancerTarget: StatusPromptEnhancerTarget | undefined;
	voiceMicTarget: StatusVoiceMicTarget | undefined;
	voiceLanguageTarget: StatusVoiceLanguageTarget | undefined;
};

export type RenderHitMap = {
	targets: Map<number, RenderedLine["target"]>;
	rowTexts: Map<number, string>;
	rowBackgrounds: Map<number, string>;
	imageTargets: Map<number, readonly ImageClickTarget[]>;
	tabLineTargets: TabLineMouseTarget[];
	status: StatusRenderHitMap | undefined;
};

export function createRenderHitMap(): RenderHitMap {
	return {
		targets: new Map(),
		rowTexts: new Map(),
		rowBackgrounds: new Map(),
		imageTargets: new Map(),
		tabLineTargets: [],
		status: undefined,
	};
}
