import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { AppStatusController } from "../src/app/screen/status-controller.js";
import type { AppBlinkController } from "../src/app/screen/blink-controller.js";
import { modelProviderThemeColor, StatusLineRenderer } from "../src/app/rendering/status-line-renderer.js";
import { ScreenStyler } from "../src/app/screen/screen-styler.js";
import { APP_ICONS } from "../src/app/icons.js";
import { displayIndexForColumn, stringDisplayWidth } from "../src/terminal-width.js";
import { colorize, THEMES } from "../src/theme.js";
import type { ModelColorsConfig } from "../src/config.js";

describe("AppStatusController", () => {
	it("tracks manual and session-following status labels", () => {
		let session = { ...sessionWithContextPercent(42), model: { provider: "provider", id: "model" }, thinkingLevel: "medium" } as AgentSession;
		const controller = new AppStatusController({
			cwd: "/tmp/workspace",
			theme: THEMES.dark,
			blinkController: fakeBlinkController(),
			runtimeSession: () => session,
			render: () => {},
		});

		controller.setStatus("ready");
		assert.equal(controller.currentStatus(), "ready");
		controller.setSessionStatus(session);
		assert.equal(controller.currentStatus(), `provider/model ${APP_ICONS.lightbulb} medium 42%`);

		session = { ...session, model: undefined, thinkingLevel: "off", getContextUsage: () => undefined } as AgentSession;
		assert.equal(controller.currentStatus(), `no model ${APP_ICONS.lightbulb} off ?%`);
	});

	it("formats session, workspace, context, and severity labels", async () => {
		let renders = 0;
		const blink = fakeBlinkController();
		const controller = new AppStatusController({
			cwd: "/tmp/my-project",
			theme: THEMES.dark,
			blinkController: blink,
			runtimeSession: () => undefined,
			render: () => { renders += 1; },
		});
		const named = { ...sessionWithContextPercent(7), sessionName: "  Feature work  " } as AgentSession;
		const unnamed = { ...sessionWithContextPercent(7), sessionName: " ", sessionId: "abcdef123456" } as AgentSession;

		assert.equal(controller.statusSessionLabel(named), "Feature work");
		assert.equal(controller.statusSessionLabel(unnamed), "session abcdef12");
		assert.equal(controller.statusWorkspaceLabel(), "my-project");
		assert.equal(controller.roundedContextUsagePercent(sessionWithContextPercent(49.6)), 50);
		assert.equal(controller.contextUsagePercentColor(30), THEMES.dark.colors.success);
		assert.equal(controller.contextUsagePercentColor(50), THEMES.dark.colors.warning);
		assert.equal(controller.contextUsagePercentColor(51), THEMES.dark.colors.error);

		controller.setSessionActivity("running");
		assert.equal(controller.sessionActivity, "running");
		assert.equal(controller.statusDotBright, false);
		controller.setSessionActivity("idle");
		assert.equal(controller.sessionActivity, "idle");
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.ok(renders >= 0);
	});

	it("formats single-digit context percentages with a leading space", () => {
		const controller = new AppStatusController({
			cwd: process.cwd(),
			theme: THEMES.dark,
			blinkController: fakeBlinkController(),
			runtimeSession: () => undefined,
			render: () => {},
		});

		assert.equal(controller.formatContextUsagePercent(sessionWithContextPercent(7)), " 7%");
		assert.equal(controller.formatContextUsagePercent(sessionWithContextPercent(32)), "32%");
		assert.equal(controller.formatContextUsagePercent(sessionWithContextPercent(Number.NaN)), "?%");
	});
});

describe("StatusLineRenderer", () => {
	it("places the voice widget flush right in the status bar", () => {
		const widgetText = `${APP_ICONS.microphone} RU`;
		const width = 40;
		const renderer = statusLineRenderer({ widgetText, voiceActive: false });

		const layout = renderer.inputBorderWidgetsLayout(width)!;
		const borderWidgetText = widgetsText(APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools, APP_ICONS.microphone, "RU");
		const expectedStartColumn = width + 1 - stringDisplayWidth(borderWidgetText);

		assert.equal(layout.inputBorderWidgetStartColumn, expectedStartColumn);
		assert.equal(layout.text, borderWidgetText);
		assert.equal(layout.voiceWidget?.startColumn, expectedStartColumn + stringDisplayWidth(widgetsText(APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools)) + 1);
		assert.equal(layout.voiceWidget?.languageStartColumn, layout.voiceWidget!.micEndColumn + 1);
		assert.equal(layout.voiceWidget?.endColumn, layout.voiceWidget!.startColumn + stringDisplayWidth(`${APP_ICONS.microphone} RU`));
		assert.equal(layout.voiceWidget?.endColumn, width + 1);
	});

	it("renders status-bar widgets without button backgrounds or separators", () => {
		const width = 40;
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false });
		const widgetLayout = renderer.inputBorderWidgetsLayout(width)!;
		const layout = renderer.layout(width);
		const rendered = renderer.render(1, layout, width);

		assert.equal(widgetLayout.inputBorderWidgetStartColumn, width + 1 - stringDisplayWidth(widgetLayout.text));
		assert.ok(layout.text.endsWith(widgetLayout.text));
		assert.ok(widgetLayout.text.includes(widgetsText(APP_ICONS.user, APP_ICONS.thinkingExpanded)));
		assert.ok(rendered.includes(colorize(iconButtonText(APP_ICONS.user), {
			foreground: THEMES.dark.colors.muted,
		})));
		assert.ok(!widgetLayout.text.includes("─"));
		assert.equal(rendered.includes(THEMES.dark.colors.inputBorderWidgetBackground), false);
	});

	it("does not expose a language click target for mic-only voice widget", () => {
		const widgetText = APP_ICONS.microphone;
		const renderer = statusLineRenderer({ widgetText, voiceActive: false });
		const layout = renderer.inputBorderWidgetsLayout(40)!;

		assert.equal(renderer.voiceLanguageTarget(layout, 1), undefined);
		assert.ok(layout.text.endsWith(iconButtonText(widgetText)));
	});

	it("colors only the microphone red while voice recording is active", () => {
		const widgetText = `${APP_ICONS.microphone} RU`;
		const renderer = statusLineRenderer({ widgetText, voiceActive: true });
		const widgetLayout = renderer.inputBorderWidgetsLayout(40)!;
		const layout = renderer.layout(40);

		const rendered = renderer.render(1, layout, 40);
		const activeMicPrefix = colorize(iconButtonText(APP_ICONS.microphone), {
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
		assert.ok(widgetLayout.text.endsWith(widgetsText(APP_ICONS.microphone, "RU")));
	});

	it("replaces the microphone icon with voice progress while keeping the language button", () => {
		const widgetText = `${APP_ICONS.microphone} RU ${APP_ICONS.timerSand}`;
		const renderer = statusLineRenderer({ widgetText, voiceActive: false });
		const layout = renderer.inputBorderWidgetsLayout(40)!;

		assert.ok(layout.text.endsWith(widgetsText(APP_ICONS.timerSand, "RU")));
		assert.ok(!layout.text.endsWith(`${APP_ICONS.microphone} RU ${APP_ICONS.timerSand}`));
		assert.equal(layout.voiceWidget?.languageStartColumn, layout.voiceWidget!.micEndColumn + 1);
		assert.equal(layout.voiceWidget?.languageEndColumn, layout.voiceWidget!.languageStartColumn + stringDisplayWidth("RU"));
		assert.deepEqual(renderer.voiceLanguageTarget(layout, 1), {
			row: 1,
			startColumn: layout.voiceWidget!.languageStartColumn,
			endColumn: layout.voiceWidget!.languageEndColumn,
		});
	});

	it("replaces the microphone icon with voice progress when no language switcher is shown", () => {
		const widgetText = `${APP_ICONS.microphone} ${APP_ICONS.timerSand}`;
		const renderer = statusLineRenderer({ widgetText, voiceActive: false });
		const layout = renderer.inputBorderWidgetsLayout(40)!;

		assert.ok(layout.text.endsWith(iconButtonText(APP_ICONS.timerSand)));
		assert.ok(!layout.text.endsWith(`${APP_ICONS.microphone}${APP_ICONS.timerSand}`));
		assert.equal(renderer.voiceLanguageTarget(layout, 1), undefined);
	});

	it("places the prompt enhancer icon before the right-side status icons", () => {
		const widgetText = `${APP_ICONS.microphone} RU`;
		const promptWidgetText = APP_ICONS.autoFix;
		const width = 40;
		const renderer = statusLineRenderer({ widgetText, voiceActive: false, promptWidgetText, promptActive: false });

		const layout = renderer.inputBorderWidgetsLayout(width)!;

		assert.ok(layout.text.endsWith(widgetsText(promptWidgetText, APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools, APP_ICONS.microphone, "RU")));
		assert.equal(layout.promptEnhancerWidget?.endColumn, (layout.userJumpWidget?.startColumn ?? 0) - 1);
		assert.equal(layout.compactToolsWidget?.endColumn, (layout.voiceWidget?.startColumn ?? 0) - 1);
	});

	it("keeps the prompt enhancer icon before the user icon without draft queue input", () => {
		const widgetText = `${APP_ICONS.microphone} RU`;
		const promptWidgetText = APP_ICONS.autoFix;
		const width = 40;
		const renderer = statusLineRenderer({ widgetText, voiceActive: false, promptWidgetText, promptActive: false });

		const layout = renderer.inputBorderWidgetsLayout(width)!;
		assert.ok(layout.text.endsWith(widgetsText(promptWidgetText, APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools, APP_ICONS.microphone, "RU")));
		assert.equal(layout.promptEnhancerWidget?.endColumn, (layout.userJumpWidget?.startColumn ?? 0) - 1);
	});

	it("renders the prompt enhancer icon muted and non-clickable when disabled", () => {
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, promptWidgetText: APP_ICONS.autoFix, promptActive: false, promptEnabled: false });
		const layout = renderer.layout(40);
		const rendered = renderer.render(1, layout, 40);
		const mutedIcon = colorize(iconButtonText(APP_ICONS.autoFix), {
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
			currentStatus: `model ${APP_ICONS.lightbulb} medium ?%`,
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
			currentStatus: `anthropic/claude-sonnet-4 ${APP_ICONS.lightbulb} medium ?%`,
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
			currentStatus: `zai/glm-5-turbo ${APP_ICONS.lightbulb} medium ?%`,
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
			currentStatus: `antigravity/antigravity-claude-sonnet-4 ${APP_ICONS.lightbulb} medium ?%`,
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
			currentStatus: `model ${APP_ICONS.lightbulb} high ?%`,
			thinkingLabel: "high",
		});
		const layout = renderer.layout(80);
		const rendered = renderer.render(1, layout, 80);

		assert.ok(rendered.includes(colorize(`${APP_ICONS.lightbulb} high`, {
			foreground: THEMES.dark.colors.error,
		})));
	});

	it("uses the muted theme thinking palette from off through xhigh", () => {
		const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
		const expectedColors = [
			THEMES.dark.colors.muted,
			THEMES.dark.colors.success,
			THEMES.dark.colors.modelOpenAI,
			THEMES.dark.colors.warning,
			THEMES.dark.colors.error,
			THEMES.dark.colors.thinkingXHigh,
		];

		for (const [index, level] of levels.entries()) {
			const renderer = statusLineRenderer({
				widgetText: "",
				voiceActive: false,
				session: sessionWithThinkingLevels(levels),
				currentStatus: `model ${APP_ICONS.lightbulb} ${level} ?%`,
				thinkingLabel: level,
			});
			const layout = renderer.layout(80);
			const rendered = renderer.render(1, layout, 80);

			assert.ok(rendered.includes(colorize(`${APP_ICONS.lightbulb} ${level}`, {
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
			currentStatus: `model ${APP_ICONS.lightbulb} none ?%`,
			thinkingLabel: "none",
		});
		const layout = renderer.layout(80);
		const rendered = renderer.render(1, layout, 80);

		assert.ok(rendered.includes(colorize(`${APP_ICONS.lightbulb} none`, {
			foreground: THEMES.dark.colors.statusForeground,
		})));
	});

	it("places model usage limits after the workspace label", () => {
		const usageLabel = "48% ██▍   12:31 • 92% ████▋ 06.01";
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, modelUsageLabel: usageLabel });

		const layout = renderer.layout(80);

		assert.equal(layout.modelUsageLabel, usageLabel);
		assert.ok(layout.details.endsWith(`workspace ${usageLabel}`));
	});

	it("colors model usage bars by remaining quota thresholds", () => {
		const usageLabel = "50% ██▌   06.01 • 20% █     12:31";
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, modelUsageLabel: usageLabel });
		const layout = renderer.layout(100);
		const rendered = renderer.render(1, layout, 100);

		assert.ok(rendered.includes(colorize("50%", {
			foreground: THEMES.dark.colors.success,
		})));
		assert.ok(rendered.includes(colorize("20%", {
			foreground: THEMES.dark.colors.warning,
		})));

		const lowRenderer = statusLineRenderer({ widgetText: "", voiceActive: false, modelUsageLabel: "19% ▉     12:01" });
		const lowLayout = lowRenderer.layout(100);
		const lowRendered = lowRenderer.render(1, lowLayout, 100);
		assert.ok(lowRendered.includes(colorize("19%", {
			foreground: THEMES.dark.colors.error,
		})));
	});

	it("renders Antigravity usage email with the limit color", () => {
		const usageLabel = "user@example.com 20% █     06.01";
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, modelUsageLabel: usageLabel });
		const layout = renderer.layout(100);
		const rendered = renderer.render(1, layout, 100);

		assert.ok(rendered.includes(colorize("user@example.com", {
			foreground: THEMES.dark.colors.warning,
		})));
	});

	it("returns a click target for the model usage label", () => {
		const usageLabel = "user@example.com 99% ████▉ 06.01";
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

	it("renders the super-compact tools target with the input-border widgets", () => {
		const widgetText = `${APP_ICONS.microphone} RU`;
		const promptWidgetText = APP_ICONS.autoFix;
		const renderer = statusLineRenderer({ widgetText, voiceActive: false, promptWidgetText, promptActive: false, superCompactToolsActive: true });
		const widgetLayout = renderer.inputBorderWidgetsLayout(40)!;
		const layout = renderer.layout(40);
		const rendered = renderer.render(1, layout, 40);
		const target = renderer.compactToolsTarget(layout, 1);

		assert.ok(widgetLayout.text.endsWith(widgetsText(promptWidgetText, APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools, APP_ICONS.microphone, "RU")));
		assert.deepEqual(target, {
			row: 1,
			startColumn: layout.compactToolsWidget?.startColumn,
			endColumn: layout.compactToolsWidget?.endColumn,
		});
		assert.ok(rendered.includes(colorize(iconButtonText(APP_ICONS.compactTools), {
			foreground: THEMES.dark.colors.info,
		})));
	});

	it("renders the user jump target before all-thinking-expanded", () => {
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, userMessageJumpMenuActive: true });
		const widgetLayout = renderer.inputBorderWidgetsLayout(40)!;
		const layout = renderer.layout(40);
		const rendered = renderer.render(1, layout, 40);
		const target = renderer.userJumpTarget(layout, 1);

		assert.ok(widgetLayout.text.endsWith(widgetsText(APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools)));
		assert.deepEqual(target, {
			row: 1,
			startColumn: layout.userJumpWidget?.startColumn,
			endColumn: layout.userJumpWidget?.endColumn,
		});
		assert.ok(rendered.includes(colorize(iconButtonText(APP_ICONS.user), {
			foreground: THEMES.dark.colors.info,
		})));
	});

	it("renders the draft queue button before the input-border icons when editor text is waiting", () => {
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, queueableInputActive: true });
		const layout = renderer.inputBorderWidgetsLayout(40)!;
		const statusLayout = renderer.layout(40);
		const rendered = renderer.render(1, statusLayout, 40);
		const buttonText = APP_ICONS.timerSand;
		const target = renderer.draftQueueTarget(statusLayout, 1);

		assert.equal(layout.inputBorderWidgetStartColumn, 40 + 1 - stringDisplayWidth(layout.text));
		assert.ok(layout.text.endsWith(widgetsText(buttonText, APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools)));
		assert.deepEqual(target, {
			row: 1,
			startColumn: statusLayout.draftQueueWidget?.startColumn,
			endColumn: statusLayout.draftQueueWidget?.endColumn,
		});
		assert.equal(layout.draftQueueWidget?.endColumn, (layout.userJumpWidget?.startColumn ?? 0) - 1);
		assert.ok(rendered.includes(colorize(iconButtonText(buttonText), {
			foreground: THEMES.dark.colors.info,
		})));
	});

	it("places the prompt enhancer immediately after the draft queue button", () => {
		const renderer = statusLineRenderer({
			widgetText: "",
			voiceActive: false,
			queueableInputActive: true,
			promptWidgetText: APP_ICONS.autoFix,
			promptActive: false,
		});
		const layout = renderer.inputBorderWidgetsLayout(40)!;

		assert.ok(layout.text.endsWith(widgetsText(APP_ICONS.timerSand, APP_ICONS.autoFix, APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools)));
		assert.equal(layout.draftQueueWidget?.endColumn, (layout.promptEnhancerWidget?.startColumn ?? 0) - 1);
		assert.equal(layout.promptEnhancerWidget?.endColumn, (layout.userJumpWidget?.startColumn ?? 0) - 1);
	});

	it("keeps the prompt enhancer before the user icon when the draft queue button is hidden", () => {
		const renderer = statusLineRenderer({
			widgetText: "",
			voiceActive: false,
			queueableInputActive: false,
			promptWidgetText: APP_ICONS.autoFix,
			promptActive: false,
		});
		const layout = renderer.inputBorderWidgetsLayout(40)!;

		assert.equal(layout.draftQueueWidget, undefined);
		assert.ok(layout.text.endsWith(widgetsText(APP_ICONS.autoFix, APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools)));
		assert.equal(layout.promptEnhancerWidget?.endColumn, (layout.userJumpWidget?.startColumn ?? 0) - 1);
	});

	it("hides the draft queue button when the editor has no queueable input", () => {
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, queueableInputActive: false });
		const layout = renderer.inputBorderWidgetsLayout(40)!;

		assert.equal(layout.draftQueueWidget, undefined);
		assert.equal(renderer.draftQueueTarget(layout, 1), undefined);
		assert.equal(layout.inputBorderWidgetStartColumn, 40 + 1 - stringDisplayWidth(layout.text));
		assert.ok(layout.text.endsWith(widgetsText(APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools)));
	});

	it("renders the all-thinking-expanded target before super-compact tools", () => {
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, allThinkingExpandedActive: true });
		const widgetLayout = renderer.inputBorderWidgetsLayout(40)!;
		const layout = renderer.layout(40);
		const rendered = renderer.render(1, layout, 40);
		const target = renderer.thinkingExpandTarget(layout, 1);

		assert.ok(widgetLayout.text.endsWith(widgetsText(APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools)));
		assert.deepEqual(target, {
			row: 1,
			startColumn: layout.thinkingExpandWidget?.startColumn,
			endColumn: layout.thinkingExpandWidget?.endColumn,
		});
		assert.ok(rendered.includes(colorize(iconButtonText(APP_ICONS.thinkingExpanded), {
			foreground: THEMES.dark.colors.info,
		})));
	});

	it("renders a terminal bell notification toggle before all-thinking-expanded", () => {
		const renderer = statusLineRenderer({ widgetText: "", voiceActive: false, terminalBellWidgetText: APP_ICONS.volumeOff, terminalBellSoundEnabled: false });
		const widgetLayout = renderer.inputBorderWidgetsLayout(40)!;
		const layout = renderer.layout(40);
		const rendered = renderer.render(1, layout, 40);
		const target = renderer.terminalBellSoundTarget(layout, 1);

		assert.ok(widgetLayout.text.endsWith(widgetsText(APP_ICONS.user, APP_ICONS.volumeOff, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools)));
		assert.equal(layout.terminalBellSoundWidget?.endColumn, (layout.thinkingExpandWidget?.startColumn ?? 0) - 1);
		assert.deepEqual(target, {
			row: 1,
			startColumn: layout.terminalBellSoundWidget?.startColumn,
			endColumn: layout.terminalBellSoundWidget?.endColumn,
		});
		assert.ok(rendered.includes(colorize(iconButtonText(APP_ICONS.volumeOff), {
			foreground: THEMES.dark.colors.muted,
		})));
	});

	it("renders quick-scroll arrows on the right according to scroll position", () => {
		const topRenderer = statusLineRenderer({ widgetText: "", voiceActive: false, quickScroll: { up: false, down: true } });
		const middleRenderer = statusLineRenderer({ widgetText: "", voiceActive: false, quickScroll: { up: true, down: true } });
		const bottomRenderer = statusLineRenderer({ widgetText: "", voiceActive: false, quickScroll: { up: true, down: false } });

		assert.ok(topRenderer.inputBorderWidgetsLayout(40)!.text.endsWith(widgetsText(APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools, APP_ICONS.down)));
		assert.ok(middleRenderer.inputBorderWidgetsLayout(40)!.text.endsWith(widgetsText(APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools, APP_ICONS.up, APP_ICONS.down)));
		assert.ok(bottomRenderer.inputBorderWidgetsLayout(40)!.text.endsWith(widgetsText(APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools, APP_ICONS.up)));

		const voiceRenderer = statusLineRenderer({ widgetText: `${APP_ICONS.microphone} RU`, voiceActive: false, quickScroll: { up: true, down: true } });
		assert.ok(voiceRenderer.inputBorderWidgetsLayout(40)!.text.endsWith(widgetsText(APP_ICONS.user, APP_ICONS.thinkingExpanded, APP_ICONS.compactTools, APP_ICONS.up, APP_ICONS.down, APP_ICONS.microphone, "RU")));
	});
});


describe("StatusLineRenderer target helpers", () => {
	it("exposes click targets for status text and voice language widgets", () => {
	const session = {
		model: { provider: "anthropic", id: "claude-sonnet-4" },
	} as AgentSession;
	const renderer = statusLineRenderer({
		widgetText: `${APP_ICONS.microphone} RU`,
		voiceActive: false,
		session,
		currentStatus: `anthropic/claude-sonnet-4 ${APP_ICONS.lightbulb} medium ?%`,
		thinkingLabel: "medium",
		modelLabel: "anthropic/claude-sonnet-4",
		workspaceLabel: "workspace",
	});
	const layout = renderer.layout(80);
	const widgetLayout = renderer.inputBorderWidgetsLayout(80)!;
	const modelLabel = "anthropic/claude-sonnet-4";
	const thinkingLabel = `${APP_ICONS.lightbulb} medium`;
	const contextLabel = "?%";

	assert.deepEqual(renderer.modelTarget(layout.text, 1), {
		row: 1,
		startColumn: layout.text.indexOf(modelLabel) + 1,
		endColumn: layout.text.indexOf(modelLabel) + 1 + modelLabel.length,
	});
	assert.deepEqual(renderer.thinkingTarget(layout.text, 1), {
		row: 1,
		startColumn: layout.text.indexOf(thinkingLabel) + 1,
		endColumn: layout.text.indexOf(thinkingLabel) + 1 + thinkingLabel.length,
	});
	assert.deepEqual(renderer.contextTarget(layout.text, 1, layout), {
		row: 1,
		startColumn: layout.text.indexOf(contextLabel) + 1,
		endColumn: layout.text.indexOf(contextLabel) + 1 + contextLabel.length,
	});
	assert.deepEqual(renderer.voiceLanguageTarget(widgetLayout, 2), {
		row: 2,
		startColumn: widgetLayout.voiceWidget?.languageStartColumn,
		endColumn: widgetLayout.voiceWidget?.languageEndColumn,
	});
	assert.deepEqual(renderer.sessionTarget("prefix session workspace", 1, "session", "workspace"), {
		row: 1,
		startColumn: 8,
		endColumn: 15,
	});
});

});

function iconButtonText(icon: string): string {
	return icon;
}

function widgetsText(...parts: string[]): string {
	return parts.filter((part) => part.length > 0).join(" ");
}

function overlayText(text: string, startColumn: number, overlay: string): string {
	const start = Math.max(0, startColumn - 1);
	const overlayWidth = stringDisplayWidth(overlay);
	const startIndex = displayIndexForColumn(text, start + 1);
	const endIndex = displayIndexForColumn(text, start + overlayWidth + 1);
	const padded = text.padEnd(startIndex, " ");
	return `${padded.slice(0, startIndex)}${overlay}${padded.slice(endIndex)}`;
}

function statusLineRenderer(options: { widgetText: string; voiceActive: boolean; promptWidgetText?: string; promptActive?: boolean; promptEnabled?: boolean; terminalBellWidgetText?: string; terminalBellSoundEnabled?: boolean; sessionActivity?: "idle" | "running" | "thinking"; statusDotBright?: boolean; workspaceLabel?: string; workspaceGitBranchLabel?: string; modelUsageLabel?: string; session?: AgentSession; currentStatus?: string; thinkingLabel?: string; modelLabel?: string; modelColors?: ModelColorsConfig; userMessageJumpMenuActive?: boolean; queueableInputActive?: boolean; allThinkingExpandedActive?: boolean; superCompactToolsActive?: boolean; quickScroll?: { up: boolean; down: boolean } }): StatusLineRenderer {
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
		terminalBellSoundStatusWidgetText: () => options.terminalBellWidgetText ?? "",
		terminalBellSoundStatusWidgetEnabled: () => options.terminalBellSoundEnabled ?? true,
		voiceStatusWidgetText: () => options.widgetText,
		voiceStatusWidgetActive: () => options.voiceActive,
		conversationQuickScrollDirections: () => options.quickScroll ?? { up: false, down: false },
		queueableInputActive: () => Boolean(options.queueableInputActive),
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
