import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { APP_ICONS } from "../src/app/icons.js";
import { stringDisplayWidth } from "../src/terminal-width.js";
import { THEMES } from "../src/theme.js";
import { ScreenStyler } from "../src/app/screen/screen-styler.js";
import { RESUME_MENU_INITIAL_SESSION_ROWS, RESUME_MENU_LOAD_BATCH_ROWS, RESUME_MENU_LOAD_THRESHOLD_ROWS } from "../src/app/constants.js";
import { AppPopupMenuController, buildUserMessageJumpItems, formatSessionInfoMenuItems, type AppPopupMenuControllerHost } from "../src/app/popup/popup-menu-controller.js";
import { PopupMenuRenderer, formatPopupMenuHeader, type PopupMenuRendererHost } from "../src/app/rendering/popup-menu-renderer.js";
import type { Entry, RenderedLine } from "../src/app/types.js";
import type { PopupMenuItem } from "../src/ui.js";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

type TestPopupMenuHost = AppPopupMenuControllerHost & PopupMenuRendererHost;

describe("popup menu header", () => {
	it("renders a title with an Esc button inside the menu width", () => {
		const header = formatPopupMenuHeader("Select model", 32);

		assert.equal(stringDisplayWidth(header), 32);
		assert.match(header, /Select model/);
		assert.ok(header.startsWith("Select model"));
		assert.ok(header.endsWith("Esc"));
	});

	it("sanitizes and truncates long titles", () => {
		const header = formatPopupMenuHeader("Very\nlong\u001b menu title", 14);

		assert.equal(stringDisplayWidth(header), 14);
		assert.ok(header.endsWith("Esc"));
		assert.doesNotMatch(header, /\n|\u001b/u);
	});

	it("keeps very narrow headers inside the menu width", () => {
		const header = formatPopupMenuHeader("Menu", 4);

		assert.equal(stringDisplayWidth(header), 4);
		assert.equal(header.trim(), "Esc");
	});

	it("styles headers with a lighter popup header background", () => {
		const theme = THEMES.dark;
		const controller = createPopupMenuController(createPopupMenuHost([], theme));
		const output = controller.styleOverlayLine(1, {
			text: formatPopupMenuHeader("Commands", 32),
			variant: "accent",
			backgroundOverride: theme.colors.popupHeaderBackground,
			target: { kind: "popup-menu-close" },
		}, 32);

		assert.match(output, ansiColor("48", theme.colors.popupHeaderBackground));
		assert.match(output, ansiColor("38", theme.colors.accent));
	});

	it("styles the inverse popup cursor with the input cursor background", () => {
		const theme = THEMES.dark;
		const controller = createPopupMenuController(createPopupMenuHost([], theme));
		const output = controller.styleOverlayLine(1, {
			text: "Copy",
			target: { kind: "popup-menu", index: 0 },
		}, 32);

		assert.match(output, ansiColor("38", theme.colors.inputBackground));
		assert.match(output, ansiColor("48", theme.colors.inputCursorBackground));
	});

	it("keeps the popup menu inset from both screen edges", () => {
		const controller = createPopupMenuController(createPopupMenuHost([]));
		const output = controller.overlayPlainText({ text: "Commands" }, 80);

		assert.equal(controller.effectivePopupMenuWidth(80), 76);
		assert.equal(output.length, 80);
		assert.ok(output.startsWith("  Commands"));
		assert.ok(output.endsWith("  "));
	});

	it("renders a header for the inline user-message action menu", () => {
		const entry: Extract<Entry, { kind: "user" }> = { id: "user-1", kind: "user", text: "hello" };
		const controller = createPopupMenuController(createPopupMenuHost([entry]));

		assert.equal(controller.openUserMessageMenu(entry.id), true);

		const lines = controller.renderInlineUserMessageMenu(entry, {
			userContentWidth: 32,
			userContentLeft: 2,
			userLine: (text): RenderedLine => ({ text }),
		});

		assert.match(lines[0]?.text ?? "", /Message actions/);
		assert.ok(lines[0]?.text.endsWith("Esc"));
		assert.deepEqual(lines[0]?.target, { kind: "popup-menu-close" });
		assert.equal(lines[0]?.segments?.[0]?.background, THEMES.dark.colors.popupHeaderBackground);
		assert.equal(lines[1]?.target?.kind, "popup-menu");
		assert.equal(lines.length, 2);
		assert.ok(lines.every((line) => !/Cancel/.test(line.text)));
	});

	it("filters close-style Cancel rows from SDK menus", () => {
		const controller = createPopupMenuController(createPopupMenuHost([]));
		void controller.showSdkMenu([
			{ value: "keep", label: "Keep" },
			{ value: "cancel", label: "Cancel", description: "Close this menu" },
		], { title: "SDK menu" });

		const lines = controller.renderActivePopupMenu(40);

		assert.ok(lines.some((line) => /Keep/.test(line.text)));
		assert.ok(lines.every((line) => !/Cancel/.test(line.text)));
		controller.closeSdkMenu(undefined, { render: false });
	});

	it("formats resume sessions as a fork tree when not searching", () => {
		const root = sessionInfo("root", "/sessions/root.jsonl", "Root", new Date("2024-01-01T00:00:00Z"));
		const olderFork = sessionInfo("older", "/sessions/older.jsonl", "Older fork", new Date("2024-01-02T00:00:00Z"), root.path);
		const newerFork = sessionInfo("newer", "/sessions/newer.jsonl", "Newer fork", new Date("2024-01-03T00:00:00Z"), root.path);
		const unrelated = sessionInfo("other", "/sessions/other.jsonl", "Other", new Date("2024-01-04T00:00:00Z"));

		const items = formatSessionInfoMenuItems([root, olderFork, newerFork, unrelated], undefined, "");

		assert.deepEqual(items.map((item) => item.label), [
			"Other",
			"Root",
			"   ├─ Newer fork",
			"   └─ Older fork",
		]);
	});

	it("keeps resume search results flat", () => {
		const root = sessionInfo("root", "/sessions/root.jsonl", "Root", new Date("2024-01-01T00:00:00Z"));
		const fork = sessionInfo("fork", "/sessions/fork.jsonl", "Forked work", new Date("2024-01-02T00:00:00Z"), root.path);

		const items = formatSessionInfoMenuItems([root, fork], undefined, "fork");

		assert.deepEqual(items.map((item) => item.label), ["Forked work"]);
	});

	it("limits formatted resume sessions for lazy loading", () => {
		const sessions = Array.from({ length: 60 }, (_, index) => {
			return sessionInfo(`session-${index}`, `/sessions/${index}.jsonl`, `Session ${index}`, new Date(2024, 0, index + 1));
		});

		const items = formatSessionInfoMenuItems(sessions, undefined, "", { limit: 12 });

		assert.equal(items.length, 12);
		assert.equal(items[0]?.label, "Session 59");
	});

	it("requests more resume sessions when scrolling near the lazy window end", () => {
		const { controller, requestedLimits } = createLazyResumeMenuController();

		controller.setDirectMenu("resume");
		controller.renderActivePopupMenu(80);
		for (let index = 0; index <= RESUME_MENU_INITIAL_SESSION_ROWS - RESUME_MENU_LOAD_THRESHOLD_ROWS + 1; index++) {
			controller.moveActivePopupMenuSelection(1);
			controller.renderActivePopupMenu(80);
		}

		assert.ok(requestedLimits.includes(RESUME_MENU_INITIAL_SESSION_ROWS));
		assert.ok(requestedLimits.includes(RESUME_MENU_INITIAL_SESSION_ROWS + RESUME_MENU_LOAD_BATCH_ROWS));
	});

	it("requests more resume sessions when mouse scrolling near the lazy window end", () => {
		const { controller, requestedLimits } = createLazyResumeMenuController();

		controller.setDirectMenu("resume");
		controller.renderActivePopupMenu(80);
		for (let index = 0; index < 4; index++) {
			controller.scrollActivePopupMenu(3);
			controller.renderActivePopupMenu(80);
		}

		assert.ok(requestedLimits.includes(RESUME_MENU_INITIAL_SESSION_ROWS));
		assert.ok(requestedLimits.includes(RESUME_MENU_INITIAL_SESSION_ROWS + RESUME_MENU_LOAD_BATCH_ROWS));
	});

	it("formats resume session dates in European 24-hour style", () => {
		const session = sessionInfo("root", "/sessions/root.jsonl", "Root", new Date(2024, 4, 6, 14, 5));

		const [item] = formatSessionInfoMenuItems([session], undefined, "");

		assert.match(item?.description ?? "", /06\.05\.2024 14:05/u);
	});

	it("mutes resume tree prefixes and metadata but not the session title", () => {
		const theme = THEMES.dark;
		const root = sessionInfo("root", "/sessions/root.jsonl", "Root", new Date("2024-01-01T00:00:00Z"));
		const fork = sessionInfo("fork", "/sessions/fork.jsonl", "Forked work", new Date("2024-01-02T00:00:00Z"), root.path);
		const resumeItems = formatSessionInfoMenuItems([root, fork], undefined, "").map((item) => ({
			...item,
			value: { kind: "session", session: item.value } as const,
		}));
		const controller = createPopupMenuController(createPopupMenuHost([], theme, resumeItems));

		controller.setDirectMenu("resume");
		const forkLine = controller.renderActivePopupMenu(80).find((line) => line.text.includes("Forked work"));

		assert.ok(forkLine);
		assert.deepEqual(forkLine?.segments, [
			{ start: 0, end: 6, foreground: theme.colors.popupMuted },
			{ start: 17, end: forkLine.text.length, foreground: theme.colors.popupMuted },
		]);
	});

	it("shows resume loading in the header without adding a loader row", () => {
		const controller = createPopupMenuController({
			...createPopupMenuHost([], THEMES.dark, [
				{ value: { kind: "new" }, label: "new", description: "Create a new session" },
			]),
			resumeLoading: true,
		});

		controller.setDirectMenu("resume");
		const lines = controller.renderActivePopupMenu(80);

		assert.match(lines[0]?.text ?? "", new RegExp(`Resume session ${APP_ICONS.timerSand}`, "u"));
		assert.ok(lines.every((line) => !/Loading sessions/.test(line.text)));
	});

	it("formats user message jump items without repeated action hints", () => {
		const text = "\u0434\u043e\u0431\u0430\u0432\u044c \u0432 \u0441\u0442\u0430\u0442\u0443\u0441-\u0431\u0430\u0440 \u0438\u043a\u043e\u043d\u043a\u0443 \u043f\u043e\u043a\u0430\u0437\u0430 \u043c\u0435\u043d\u044e \u043f\u0435\u0440\u0435\u0445\u043e\u0434\u0430 \u043a \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c\u0441\u043a\u0438\u043c \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f\u043c";
		const [item] = buildUserMessageJumpItems([{ id: "user-1", kind: "user", text }], "");

		assert.equal(item?.label, `1. ${text}`);
		assert.equal(item?.description, undefined);
	});

	it("renders user message jump rows across the full popup width", () => {
		const label = "1. " + "wide preview text ".repeat(4);
		const controller = createPopupMenuController({
			...createPopupMenuHost([]),
			getUserMessageJumpMenuItems: () => [{ value: { entryId: "user-1" }, label }],
		});

		controller.setDirectMenu("user-message-jump");
		const lines = controller.renderActivePopupMenu(100);

		assert.equal(lines[1]?.text, label);
		assert.doesNotMatch(lines[1]?.text ?? "", /Enter to scroll/);
	});
	it("updates and clears direct popup queries as text is typed", () => {
		const controller = createPopupMenuController(createPopupMenuHost([]));

		controller.openDirectPopupMenu("model");
		assert.equal(controller.handleDirectPopupInput("a"), true);
		assert.equal(controller.directQuery, "a");
		assert.equal(controller.handleDirectPopupInput("b"), true);
		assert.equal(controller.directQuery, "ab");
		assert.equal(controller.handleDirectPopupInput("\b"), true);
		assert.equal(controller.directQuery, "a");
	});


	it("dismisses model menus and restores session status for direct popups", () => {
		const statusChanges: string[] = [];
		const controller = createPopupMenuController({
			...createPopupMenuHost([], THEMES.dark, [
				{ value: { kind: "new" }, label: "new", description: "Create a new session" },
			]),
			getInput: () => "/model gpt-5.5",
			parseSlashInput: (text) => text.startsWith("/model") ? { commandName: "model", hasArguments: true, arguments: "gpt-5.5" } : undefined,
			setStatus: (status) => statusChanges.push(status),
			restoreSessionStatus: () => statusChanges.push("restore"),
		});

		controller.setDirectMenu("model");
		controller.cancelActivePopupMenu();

		assert.equal(controller.directMenu, undefined);
		assert.equal(controller.selectedModel(), undefined);
		assert.deepEqual(statusChanges, ["restore"]);
	});

	it("does not open SDK menus when the host is not running", async () => {
		let rendered = 0;
		const controller = createPopupMenuController({
			...createPopupMenuHost([]),
			isRunning: () => false,
			render: () => {
				rendered += 1;
			},
		});

		const result = await controller.showSdkMenu([{ value: "one", label: "One" }], { title: "SDK" });
		assert.equal(result, undefined);
		assert.equal(rendered, 0);
	});

	it("resolves SDK selections and restores session status when the menu closes", async () => {
		const statusChanges: string[] = [];
		let renders = 0;
		const controller = createPopupMenuController({
			...createPopupMenuHost([]),
			setStatus: (status) => statusChanges.push(status),
			restoreSessionStatus: () => statusChanges.push("restore"),
			render: () => {
				renders += 1;
			},
		});

		const selection = controller.showSdkMenu([
			{ value: "one", label: "One" },
			{ value: "two", label: "Two", description: "Second" },
		], { title: "SDK menu" });

		const lines = controller.renderActivePopupMenu(40);
		assert.match(lines[0]?.text ?? "", /SDK menu/u);
		assert.equal(controller.submitSelectedSdkMenu(), true);
		assert.equal(await selection, "one");
		assert.equal(controller.directMenu, undefined);
		assert.deepEqual(statusChanges, ["restore"]);
		assert.ok(renders >= 2);
	});

	it("allows direct user-message popups to accept plain input without mutating the query", () => {
		const controller = createPopupMenuController(createPopupMenuHost([]));

		controller.openDirectPopupMenu("user-message");

		assert.equal(controller.handleDirectPopupInput("a"), true);
		assert.equal(controller.handleDirectPopupInput("\b"), true);
		assert.equal(controller.directQuery, "");
		assert.equal(controller.handleDirectPopupInput("\u001b"), false);
	});

	it("cancels preserved direct popups without restoring session status", () => {
		const actions: string[] = [];
		const controller = createPopupMenuController({
			...createPopupMenuHost([]),
			restoreSessionStatus: () => actions.push("restore"),
			render: () => actions.push("render"),
		});

		controller.openDirectPopupMenu("queue-message", { preserveStatus: true });
		controller.cancelActivePopupMenu();

		assert.equal(controller.directMenu, undefined);
		assert.deepEqual(actions, ["render"]);
	});

	it("opens user and queued message popups for live entries", () => {
		const userEntry: Extract<Entry, { kind: "user" }> = { id: "user-1", kind: "user", text: "hello" };
		const queuedEntry: Extract<Entry, { kind: "queued" }> = {
			id: "queued-1",
			kind: "queued",
			mode: "follow-up",
			text: "queued",
			queueSource: "deferred",
			queueIndex: 0,
		};
		const controller = createPopupMenuController({
			...createPopupMenuHost([userEntry, queuedEntry]),
			hasQueuedEntry: (entryId) => entryId === queuedEntry.id,
			getUserMessageMenuItems: () => [{ value: "copy", label: "Copy", description: "Copy message" }],
			getQueueMessageMenuItems: () => [{ value: "edit", label: "Edit", description: "Edit queued message" }],
		});

		assert.equal(controller.openUserMessageMenu(userEntry.id), true);
		assert.deepEqual(controller.selectedUserMessageAction(), {
			value: "copy",
			label: "Copy",
			entryId: userEntry.id,
		});
		controller.closeUserMessageMenu();
		assert.equal(controller.directMenu, undefined);

		assert.equal(controller.openQueueMessageMenu(queuedEntry.id), true);
		assert.deepEqual(controller.selectedQueueMessageAction(), {
			value: "edit",
			label: "Edit",
			entryId: queuedEntry.id,
		});
		controller.closeQueueMessageMenu();
		assert.equal(controller.directMenu, undefined);
	});

});

function sessionInfo(id: string, path: string, firstMessage: string, modified: Date, parentSessionPath?: string): SessionInfo {
	return {
		path,
		id,
		cwd: "/workspace",
		created: modified,
		modified,
		messageCount: 1,
		firstMessage,
		allMessagesText: firstMessage,
		...(parentSessionPath ? { parentSessionPath } : {}),
	};
}

function createLazyResumeMenuController(): { controller: AppPopupMenuController; requestedLimits: (number | undefined)[] } {
	const sessions = Array.from({ length: 60 }, (_, index) => {
		return sessionInfo(`session-${index}`, `/sessions/${index}.jsonl`, `Session ${index}`, new Date(2024, 0, index + 1));
	});
	const requestedLimits: (number | undefined)[] = [];
	const controller = createPopupMenuController({
		...createPopupMenuHost([]),
		resumeSessionCount: sessions.length,
		getResumeMenuItems: (_query, limit) => {
			requestedLimits.push(limit);
			return [
				{ value: { kind: "new" }, label: "new", description: "Create a new session" },
				...sessions.slice(0, limit).map((session) => ({
					value: { kind: "session", session } as const,
					label: session.firstMessage,
					description: session.id,
				})),
			];
		},
	});

	return { controller, requestedLimits };
}

function createPopupMenuController(host: TestPopupMenuHost): AppPopupMenuController {
	return new AppPopupMenuController(host, new PopupMenuRenderer(host));
}

function createPopupMenuHost(
	entries: readonly Entry[],
	theme = THEMES.dark,
	resumeMenuItems: readonly PopupMenuItem<{ kind: "new" } | { kind: "session"; session: SessionInfo }>[] = [],
): TestPopupMenuHost {
	return {
		theme,
		screenStyler: new ScreenStyler({ theme, mouseSelection: undefined }),
		entries,
		session: undefined,
		resumeLoading: false,
		resumeSessionCount: 0,
		isRunning: () => true,
		getInput: () => "",
		setInput: () => undefined,
		parseSlashInput: () => undefined,
		getSlashCommandMenuItems: () => [],
		getModelMenuItems: () => [],
		getThinkingMenuItems: () => [],
		getResumeMenuItems: () => [...resumeMenuItems],
		getUserMessageMenuItems: () => [{ value: "copy", label: "Copy", description: "Copy message" }],
		getUserMessageJumpMenuItems: () => [],
		getQueueMessageMenuItems: () => [],
		hasUserEntry: (entryId) => entries.some((entry) => entry.kind === "user" && entry.id === entryId),
		hasQueuedEntry: () => false,
		setStatus: () => undefined,
		restoreSessionStatus: () => undefined,
		render: () => undefined,
	};
}

function ansiColor(prefix: "38" | "48", hex: string): RegExp {
	const normalized = hex.replace(/^#/, "");
	const red = Number.parseInt(normalized.slice(0, 2), 16);
	const green = Number.parseInt(normalized.slice(2, 4), 16);
	const blue = Number.parseInt(normalized.slice(4, 6), 16);
	return new RegExp(`\\x1b\\[[^m]*${prefix};2;${red};${green};${blue}[^m]*m`);
}
