import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { AppStatusController } from "../src/app/status-controller.js";
import type { AppBlinkController } from "../src/app/blink-controller.js";
import { modelProviderThemeColor, StatusLineRenderer } from "../src/app/status-line-renderer.js";
import { ScreenStyler } from "../src/app/screen-styler.js";
import { APP_ICONS } from "../src/app/icons.js";
import { stringDisplayWidth } from "../src/terminal-width.js";
import { colorize, THEMES } from "../src/theme.js";
import type { ModelColorsConfig } from "../src/config.js";

describe("AppStatusController", () => {
	it("formats single-digit context percentages with a leading space", () => {
		const controller = new AppStatusController({
			cwd: process.cwd(),
			theme: THEMES.dark,
			blinkController: fakeBlinkController(),
			runtimeSession: () => undefined,
		});

		assert.equal(controller.formatContextUsagePercent(sessionWithContextPercent(7)), " 7%");
		assert.equal(controller.formatContextUsagePercent(sessionWithContextPercent(32)), "32%");
		assert.equal(controller.formatContextUsagePercent(sessionWithContextPercent(Number.NaN)), "?%");
	});
});

describe("StatusLineRenderer", () => {
	it("pins the voice widget to the right edge", () => {
		const widgetText = `${APP_ICONS.microphone} RU`;
		const width = 40;
		const renderer = statusLineRenderer({ widgetText, voiceActive: false });

		const layout = renderer.layout(width);
		const widgetWidth = stringDisplayWidth(widgetText);

		assert.equal(stringDisplayWidth(layout.text), width);
		assert.ok(layout.text.endsWith(widgetText));
		assert.equal(layout.voiceWidget?.startColumn, width - widgetWidth + 1);
		assert.equal(layout.voiceWidget?.endColumn, width + 1);
	});

	it("does not expose a language click target for mic-only voice widget", () => {
		const widgetText = APP_ICONS.microphone;
		const renderer = statusLineRenderer({ widgetText, voiceActive: false });
		const layout = renderer.layout(40);

		assert.equal(renderer.voiceLanguageTarget(layout, 1), undefined);
		assert.ok(layout.text.endsWith(widgetText));
	});

	it("colors only the microphone red while voice recording is active", () => {
		const widgetText = `${APP_ICONS.microphone} RU`;
		const renderer = statusLineRenderer({ widgetText, voiceActive: true });
		const layout = renderer.layout(40);

		const rendered = renderer.render(1, layout, 40);
		const activeMicPrefix = colorize(APP_ICONS.microphone, {
			foreground: THEMES.dark.colors.error,
		});
		const activeWholeWidgetPrefix = colorize(widgetText, {
			foreground: THEMES.dark.colors.error,
		});
		const boldActiveMicPrefix = colorize(APP_ICONS.microphone, {
			foreground: THEMES.dark.colors.error,
			bold: true,
		});

		assert.ok(rendered.includes(activeMicPrefix));
		assert.ok(!rendered.includes(activeWholeWidgetPrefix));
		assert.ok(!rendered.includes(boldActiveMicPrefix));
		assert.ok(layout.text.endsWith(widgetText));
	});

	it("places the prompt enhancer icon before the voice widget", () => {
		const widgetText = `${APP_ICONS.microphone} RU`;
		const promptWidgetText = APP_ICONS.autoFix;
		const width = 40;
		const renderer = statusLineRenderer({ widgetText, voiceActive: false, promptWidgetText, promptActive: false });

		const layout = renderer.layout(width);
		const widgetWidth = stringDisplayWidth(widgetText);
		const promptWidgetWidth = stringDisplayWidth(promptWidgetText);

		assert.ok(layout.text.endsWith(`${promptWidgetText} ${widgetText}`));
		assert.equal(layout.promptEnhancerWidget?.startColumn, width - widgetWidth - promptWidgetWidth);
		assert.equal(layout.promptEnhancerWidget?.endColumn, width - widgetWidth);
		assert.equal(layout.voiceWidget?.startColumn, width - widgetWidth + 1);
	});

	it("places the prompt enhancer icon directly before the voice widget", () => {
		const widgetText = `${APP_ICONS.microphone} RU`;
		const promptWidgetText = APP_ICONS.autoFix;
		const width = 40;
		const renderer = statusLineRenderer({ widgetText, voiceActive: false, promptWidgetText, promptActive: false });

		const layout = renderer.layout(width);
		assert.ok(layout.text.endsWith(`${promptWidgetText} ${widgetText}`));
		assert.equal(layout.voiceWidget?.startColumn, (layout.promptEnhancerWidget?.endColumn ?? 0) + 1);
	});

	it("renders the prompt enhancer icon muted and non-clickable when disabled", () => {
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, promptWidgetText: APP_ICONS.autoFix, promptActive: false, promptEnabled: false });
		const layout = renderer.layout(40);
		const rendered = renderer.render(1, layout, 40);
		const mutedIcon = colorize(APP_ICONS.autoFix, {
			foreground: THEMES.dark.colors.muted,
		});

		assert.ok(rendered.includes(mutedIcon));
		assert.equal(renderer.promptEnhancerTarget(layout, 1), undefined);
	});

	it("blinks the status indicator with color only", () => {
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, sessionActivity: "running", statusDotBright: true });
		const layout = renderer.layout(40);
		const rendered = renderer.render(1, layout, 40);
		const brightDot = colorize(APP_ICONS.record, {
			foreground: THEMES.dark.colors.warning,
		});
		const boldBrightDot = colorize(APP_ICONS.record, {
			foreground: THEMES.dark.colors.warning,
			bold: true,
		});

		assert.ok(rendered.includes(brightDot));
		assert.ok(!rendered.includes(boldBrightDot));
	});

	it("renders the git branch in muted gray", () => {
		const renderer = statusLineRenderer({
			widgetText: "",
			voiceActive: false,
			workspaceLabel: "workspace (master)",
			workspaceGitBranchLabel: "(master)",
		});
		const layout = renderer.layout(50);
		const rendered = renderer.render(1, layout, 50);
		const workspacePrefix = colorize("workspace ", {
			foreground: THEMES.dark.colors.selectionForeground,
		});
		const gitBranch = colorize("(master)", {
			foreground: THEMES.dark.colors.muted,
		});

		assert.ok(rendered.includes(workspacePrefix));
		assert.ok(rendered.includes(gitBranch));
	});

	it("renders the project name and model in white", () => {
		const renderer = statusLineRenderer({
			widgetText: "",
			voiceActive: false,
			session: sessionWithThinkingLevels(["off", "low", "medium", "high"]),
			currentStatus: "model medium ?%",
			thinkingLabel: "medium",
			workspaceLabel: "workspace",
		});
		const layout = renderer.layout(80);
		const rendered = renderer.render(1, layout, 80);

		assert.ok(rendered.includes(colorize("model", {
			foreground: THEMES.dark.colors.selectionForeground,
		})));
		assert.ok(rendered.includes(colorize("workspace", {
			foreground: THEMES.dark.colors.selectionForeground,
		})));
	});

	it("colors the model label from the themed provider palette", () => {
		const renderer = statusLineRenderer({
			widgetText: "",
			voiceActive: false,
			session: sessionWithModelProvider("anthropic"),
			modelLabel: "anthropic/claude-sonnet-4",
			currentStatus: "anthropic/claude-sonnet-4 medium ?%",
		});
		const layout = renderer.layout(100);
		const rendered = renderer.render(1, layout, 100);

		assert.ok(rendered.includes(colorize("anthropic/claude-sonnet-4", {
			foreground: modelProviderThemeColor("anthropic", THEMES.dark.colors),
		})));
	});

	it("colors the model label from configured model color rules before themed fallback", () => {
		const renderer = statusLineRenderer({
			widgetText: "",
			voiceActive: false,
			session: sessionWithModelProvider("zai", "glm-5-turbo"),
			modelLabel: "zai/glm-5-turbo",
			currentStatus: "zai/glm-5-turbo medium ?%",
			modelColors: { rules: { "zai/*": "#22c55e" } },
		});
		const layout = renderer.layout(100);
		const rendered = renderer.render(1, layout, 100);

		assert.ok(rendered.includes(colorize("zai/glm-5-turbo", {
			foreground: "#22c55e",
		})));
	});

	it("prefers more specific configured model color rules", () => {
		const modelColors = {
			rules: {
				"antigravity/*": "#f97316",
				"antigravity/antigravity-claude-*": "#ef4444",
			},
		};
		const renderer = statusLineRenderer({
			widgetText: "",
			voiceActive: false,
			session: sessionWithModelProvider("antigravity", "antigravity-claude-sonnet-4"),
			modelLabel: "antigravity/antigravity-claude-sonnet-4",
			currentStatus: "antigravity/antigravity-claude-sonnet-4 medium ?%",
			modelColors,
		});
		const layout = renderer.layout(120);
		const rendered = renderer.render(1, layout, 120);

		assert.ok(rendered.includes(colorize("antigravity/antigravity-claude-sonnet-4", {
			foreground: "#ef4444",
		})));
	});

	it("uses theme-specific fallback provider colors", () => {
		assert.notEqual(modelProviderThemeColor("anthropic", THEMES.dark.colors), modelProviderThemeColor("anthropic", THEMES.light.colors));
		assert.equal(modelProviderThemeColor(" Anthropic ", THEMES.dark.colors), modelProviderThemeColor("anthropic", THEMES.dark.colors));
	});

	it("keeps visually similar provider names on separate themed fallback colors", () => {
		assert.notEqual(modelProviderThemeColor("openai-codex", THEMES.dark.colors), modelProviderThemeColor("zai", THEMES.dark.colors));
		assert.notEqual(modelProviderThemeColor("openai-codex", THEMES.light.colors), modelProviderThemeColor("zai", THEMES.light.colors));
	});

	it("colors thinking by the current model's available range", () => {
		const renderer = statusLineRenderer({
			widgetText: "",
			voiceActive: false,
			session: sessionWithThinkingLevels(["off", "low", "medium", "high"]),
			currentStatus: "model high ?%",
			thinkingLabel: "high",
		});
		const layout = renderer.layout(80);
		const rendered = renderer.render(1, layout, 80);

		assert.ok(rendered.includes(colorize("high", {
			foreground: THEMES.dark.colors.error,
		})));
	});

	it("uses the muted theme thinking palette from off through xhigh", () => {
		const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
		const expectedColors = [
			THEMES.dark.colors.muted,
			THEMES.dark.colors.success,
			THEMES.dark.colors.warning,
			THEMES.dark.colors.toolMutation,
			THEMES.dark.colors.error,
			THEMES.dark.colors.thinkingXHigh,
		];

		for (const [index, level] of levels.entries()) {
			const renderer = statusLineRenderer({
				widgetText: "",
				voiceActive: false,
				session: sessionWithThinkingLevels(levels),
				currentStatus: `model ${level} ?%`,
				thinkingLabel: level,
			});
			const layout = renderer.layout(80);
			const rendered = renderer.render(1, layout, 80);

			assert.ok(rendered.includes(colorize(level, {
				foreground: expectedColors[index],
			})));
		}

		assert.notEqual(THEMES.dark.colors.error, THEMES.dark.colors.thinkingXHigh);
	});

	it("prepends the status foreground when thinking has more levels than the base palette", () => {
		const levels = ["none", "off", "minimal", "low", "medium", "high", "xhigh"];
		const renderer = statusLineRenderer({
			widgetText: "",
			voiceActive: false,
			session: sessionWithThinkingLevels(levels),
			currentStatus: "model none ?%",
			thinkingLabel: "none",
		});
		const layout = renderer.layout(80);
		const rendered = renderer.render(1, layout, 80);

		assert.ok(rendered.includes(colorize("none", {
			foreground: THEMES.dark.colors.statusForeground,
		})));
	});

	it("places model usage limits after the workspace label", () => {
		const usageLabel = "48% ██▍   31m • 92% ████▋ 5d0h";
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, modelUsageLabel: usageLabel });

		const layout = renderer.layout(80);

		assert.equal(layout.modelUsageLabel, usageLabel);
		assert.ok(layout.details.endsWith(`workspace ${usageLabel}`));
	});

	it("colors model usage bars by remaining quota thresholds", () => {
		const usageLabel = "50% ██▌   5d0h • 20% █     31m";
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, modelUsageLabel: usageLabel });
		const layout = renderer.layout(100);
		const rendered = renderer.render(1, layout, 100);

		assert.ok(rendered.includes(colorize("50%", {
			foreground: THEMES.dark.colors.success,
		})));
		assert.ok(rendered.includes(colorize("20%", {
			foreground: THEMES.dark.colors.warning,
		})));

		const lowRenderer = statusLineRenderer({ widgetText: "", voiceActive: false, modelUsageLabel: "19% ▉     1m" });
		const lowLayout = lowRenderer.layout(100);
		const lowRendered = lowRenderer.render(1, lowLayout, 100);
		assert.ok(lowRendered.includes(colorize("19%", {
			foreground: THEMES.dark.colors.error,
		})));
	});

	it("renders Antigravity usage email in white", () => {
		const usageLabel = "user@example.com 99% ████▉ 6d22h";
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, modelUsageLabel: usageLabel });
		const layout = renderer.layout(100);
		const rendered = renderer.render(1, layout, 100);

		assert.ok(rendered.includes(colorize("user@example.com", {
			foreground: THEMES.dark.colors.selectionForeground,
		})));
	});

	it("returns a click target for the model usage label", () => {
		const usageLabel = "user@example.com 99% ████▉ 6d22h";
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, modelUsageLabel: usageLabel });
		const layout = renderer.layout(100);
		const target = renderer.modelUsageTarget(layout.text, 1, layout);

		const startColumn = layout.text.indexOf(usageLabel) + 1;
		assert.deepEqual(target, {
			row: 1,
			startColumn,
			endColumn: startColumn + usageLabel.length,
		});
	});

	it("renders the super-compact tools target with the right-side status widgets", () => {
		const widgetText = `${APP_ICONS.microphone} RU`;
		const promptWidgetText = APP_ICONS.autoFix;
		const renderer = statusLineRenderer({ widgetText, voiceActive: false, promptWidgetText, promptActive: false, superCompactToolsActive: true });
		const layout = renderer.layout(40);
		const rendered = renderer.render(1, layout, 40);
		const target = renderer.compactToolsTarget(layout, 1);

		assert.ok(layout.text.endsWith(`${APP_ICONS.compactTools} ${promptWidgetText} ${widgetText}`));
		assert.deepEqual(target, {
			row: 1,
			startColumn: (layout.promptEnhancerWidget?.startColumn ?? 0) - 2,
			endColumn: (layout.promptEnhancerWidget?.startColumn ?? 0) - 1,
		});
		assert.ok(rendered.includes(colorize(APP_ICONS.compactTools, {
			foreground: THEMES.dark.colors.info,
		})));
	});

	it("renders the user jump target before all-thinking-expanded", () => {
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, userMessageJumpMenuActive: true });
		const layout = renderer.layout(40);
		const rendered = renderer.render(1, layout, 40);
		const target = renderer.userJumpTarget(layout, 1);

		assert.ok(layout.text.endsWith(`${APP_ICONS.user} ${APP_ICONS.thinkingExpanded} ${APP_ICONS.compactTools}`));
		assert.deepEqual(target, {
			row: 1,
			startColumn: layout.userJumpWidget?.startColumn,
			endColumn: layout.userJumpWidget?.endColumn,
		});
		assert.ok(rendered.includes(colorize(APP_ICONS.user, {
			foreground: THEMES.dark.colors.info,
		})));
	});

	it("renders the all-thinking-expanded target before super-compact tools", () => {
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, allThinkingExpandedActive: true });
		const layout = renderer.layout(40);
		const rendered = renderer.render(1, layout, 40);
		const target = renderer.thinkingExpandTarget(layout, 1);

		assert.ok(layout.text.endsWith(`${APP_ICONS.user} ${APP_ICONS.thinkingExpanded} ${APP_ICONS.compactTools}`));
		assert.deepEqual(target, {
			row: 1,
			startColumn: layout.thinkingExpandWidget?.startColumn,
			endColumn: layout.thinkingExpandWidget?.endColumn,
		});
		assert.ok(rendered.includes(colorize(APP_ICONS.thinkingExpanded, {
			foreground: THEMES.dark.colors.info,
		})));
	});
});

function statusLineRenderer(options: { widgetText: string; voiceActive: boolean; promptWidgetText?: string; promptActive?: boolean; promptEnabled?: boolean; sessionActivity?: "idle" | "running" | "thinking"; statusDotBright?: boolean; workspaceLabel?: string; workspaceGitBranchLabel?: string; modelUsageLabel?: string; session?: AgentSession; currentStatus?: string; thinkingLabel?: string; modelLabel?: string; modelColors?: ModelColorsConfig; userMessageJumpMenuActive?: boolean; allThinkingExpandedActive?: boolean; superCompactToolsActive?: boolean }): StatusLineRenderer {
	return new StatusLineRenderer({
		theme: THEMES.dark,
		screenStyler: new ScreenStyler({ theme: THEMES.dark, mouseSelection: undefined }),
		session: options.session,
		modelColors: options.modelColors,
		sessionActivity: options.sessionActivity ?? "idle",
		statusDotBright: options.statusDotBright ?? false,
		currentStatus: () => options.currentStatus ?? "ready",
		statusWorkspaceLabel: () => options.workspaceLabel ?? "workspace",
		statusWorkspaceGitBranchLabel: () => options.workspaceGitBranchLabel,
		statusModelLabel: () => options.modelLabel ?? "model",
		statusThinkingLabel: () => options.thinkingLabel ?? "medium",
		formatContextUsagePercent: () => "?%",
		roundedContextUsagePercent: () => undefined,
		contextUsagePercentColor: () => THEMES.dark.colors.info,
		modelUsageStatusLabel: () => options.modelUsageLabel ?? "",
		promptEnhancerStatusWidgetText: () => options.promptWidgetText ?? "",
		promptEnhancerStatusWidgetActive: () => options.promptActive ?? false,
		promptEnhancerStatusWidgetEnabled: () => options.promptEnabled ?? true,
		voiceStatusWidgetText: () => options.widgetText,
		voiceStatusWidgetActive: () => options.voiceActive,
		userMessageJumpMenuActive: () => Boolean(options.userMessageJumpMenuActive),
		allThinkingExpandedActive: () => Boolean(options.allThinkingExpandedActive),
		superCompactToolsActive: () => Boolean(options.superCompactToolsActive),
	});
}

function fakeBlinkController(): AppBlinkController {
	return {
		setActive: () => {},
		visible: () => false,
		dispose: () => {},
	} as unknown as AppBlinkController;
}

function sessionWithContextPercent(percent: number): AgentSession {
	return {
		getContextUsage: () => ({ percent }),
	} as unknown as AgentSession;
}

function sessionWithThinkingLevels(levels: readonly string[]): AgentSession {
	return {
		getAvailableThinkingLevels: () => levels,
	} as unknown as AgentSession;
}

function sessionWithModelProvider(provider: string, id = "claude-sonnet-4"): AgentSession {
	return {
		model: { provider, id },
		getAvailableThinkingLevels: () => ["off", "medium"],
	} as unknown as AgentSession;
}
