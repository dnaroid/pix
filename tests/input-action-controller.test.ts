import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InputEditor } from "../src/input-editor.js";
import { AppInputActionController } from "../src/app/input/input-action-controller.js";
import type { AppPopupActionController } from "../src/app/popup/popup-action-controller.js";
import type { AppPopupMenuController } from "../src/app/popup/popup-menu-controller.js";
import type { AppQueuedMessageController } from "../src/app/session/queued-message-controller.js";
import type { AppRequestHistory } from "../src/app/session/request-history.js";
import type { SubmittedUserMessage } from "../src/app/types.js";

describe("AppInputActionController", () => {
	it("clears the persisted draft when submitting input", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("hello draft");
		const history: string[] = [];
		let clearDraftCalls = 0;
		let stopVoiceInputCalls = 0;
		let submitted: SubmittedUserMessage | undefined;

		const controller = new AppInputActionController(
			{
				runtime: () => undefined,
				isRunning: () => true,
				isSessionSwitching: () => false,
				inputEditor: () => inputEditor,
				requestHistory: () => ({ add: (value: string) => history.push(value) }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => {
					clearDraftCalls += 1;
				},
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: () => {},
				addSessionAbortedEntry: () => {},
				showToast: () => {},
				stopVoiceInput: async () => {
					stopVoiceInputCalls += 1;
				},
				isShellCommandRunning: () => false,
				runChatShellCommand: async () => ({ exitCode: 0, signal: null }),
				sendShellInput: () => false,
				interruptShellCommand: () => false,
				runInteractiveShellCommand: async () => ({ exitCode: 0, signal: null }),
				stop: async () => {},
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => false } as unknown as AppPopupMenuController,
			{} as AppPopupActionController,
			{
				createSubmittedUserMessage: (promptText: string, displayText: string, images: SubmittedUserMessage["images"]) => ({
					id: "queued-user-test",
					promptText,
					displayText,
					images,
				}),
				submitUserMessage: async (message: SubmittedUserMessage) => {
					submitted = message;
					assert.equal(inputEditor.text, "");
					assert.equal(clearDraftCalls, 1);
				},
			} as unknown as AppQueuedMessageController,
		);

		await (controller as unknown as { submitInput(): Promise<void> }).submitInput();

		assert.deepEqual(history, ["hello draft"]);
		assert.equal(submitted?.promptText, "hello draft");
		assert.equal(clearDraftCalls, 1);
		assert.equal(stopVoiceInputCalls, 1);
	});

	it("queues the current editor input without submitting it to the session", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("send later");
		const history: string[] = [];
		let clearDraftCalls = 0;
		let cancelMenuCalls = 0;
		let deferred: SubmittedUserMessage | undefined;
		let submitted = false;

		const controller = new AppInputActionController(
			{
				runtime: () => undefined,
				isRunning: () => true,
				isSessionSwitching: () => false,
				inputEditor: () => inputEditor,
				requestHistory: () => ({ add: (value: string) => history.push(value) }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => {
					clearDraftCalls += 1;
				},
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: () => {},
				addSessionAbortedEntry: () => {},
				showToast: () => {},
				stopVoiceInput: async () => {},
				isShellCommandRunning: () => false,
				runChatShellCommand: async () => ({ exitCode: 0, signal: null }),
				sendShellInput: () => false,
				interruptShellCommand: () => false,
				runInteractiveShellCommand: async () => ({ exitCode: 0, signal: null }),
				stop: async () => {},
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => "slash", cancelActivePopupMenu: () => { cancelMenuCalls += 1; } } as unknown as AppPopupMenuController,
			{} as AppPopupActionController,
			{
				createSubmittedUserMessage: (promptText: string, displayText: string, images: SubmittedUserMessage["images"]) => ({
					id: "queued-user-test",
					promptText,
					displayText,
					images,
				}),
				deferUserMessage: (message: SubmittedUserMessage) => {
					deferred = message;
				},
				submitUserMessage: async () => {
					submitted = true;
				},
			} as unknown as AppQueuedMessageController,
		);

		await controller.queueInputFromEditor();

		assert.equal(deferred?.promptText, "send later");
		assert.deepEqual(history, ["send later"]);
		assert.equal(inputEditor.text, "");
		assert.equal(clearDraftCalls, 1);
		assert.equal(cancelMenuCalls, 1);
		assert.equal(submitted, false);
	});

	it("stops voice input before reading submitted text", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("hello");
		let submitted: SubmittedUserMessage | undefined;

		const controller = new AppInputActionController(
			{
				runtime: () => undefined,
				isRunning: () => true,
				isSessionSwitching: () => false,
				inputEditor: () => inputEditor,
				requestHistory: () => ({ add: () => {} }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => {},
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: () => {},
				addSessionAbortedEntry: () => {},
				showToast: () => {},
				stopVoiceInput: async () => {
					inputEditor.insert(" world");
				},
				isShellCommandRunning: () => false,
				runChatShellCommand: async () => ({ exitCode: 0, signal: null }),
				sendShellInput: () => false,
				interruptShellCommand: () => false,
				runInteractiveShellCommand: async () => ({ exitCode: 0, signal: null }),
				stop: async () => {},
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => false } as unknown as AppPopupMenuController,
			{} as AppPopupActionController,
			{
				createSubmittedUserMessage: (promptText: string, displayText: string, images: SubmittedUserMessage["images"]) => ({
					id: "queued-user-test",
					promptText,
					displayText,
					images,
				}),
				submitUserMessage: async (message: SubmittedUserMessage) => {
					submitted = message;
				},
			} as unknown as AppQueuedMessageController,
		);

		await (controller as unknown as { submitInput(): Promise<void> }).submitInput();

		assert.equal(submitted?.promptText, "hello world");
	});

	it("runs bang-prefixed shell commands in chat instead of submitting to the agent", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("!npm test");
		const history: string[] = [];
		const entries: Array<{ kind: string; text: string }> = [];
		let clearDraftCalls = 0;
		let chatShellCommand: string | undefined;
		let interactiveShellCommand: string | undefined;
		let submitCalls = 0;

		const controller = new AppInputActionController(
			{
				runtime: () => undefined,
				isRunning: () => true,
				isSessionSwitching: () => false,
				inputEditor: () => inputEditor,
				requestHistory: () => ({ add: (value: string) => history.push(value) }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => {
					clearDraftCalls += 1;
				},
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: (entry) => entries.push({ kind: entry.kind, text: "text" in entry ? entry.text : entry.output }),
				addSessionAbortedEntry: () => {},
				showToast: () => {},
				stopVoiceInput: async () => {},
				isShellCommandRunning: () => false,
				runChatShellCommand: async (command: string) => {
					chatShellCommand = command;
					return { exitCode: 0, signal: null };
				},
				sendShellInput: () => false,
				interruptShellCommand: () => false,
				runInteractiveShellCommand: async (command: string) => {
					interactiveShellCommand = command;
					return { exitCode: 0, signal: null };
				},
				stop: async () => {},
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => false } as unknown as AppPopupMenuController,
			{} as AppPopupActionController,
			{
				createSubmittedUserMessage: () => {
					throw new Error("shell command should not create a user message");
				},
				submitUserMessage: async () => {
					submitCalls += 1;
				},
			} as unknown as AppQueuedMessageController,
		);

		await (controller as unknown as { submitInput(): Promise<void> }).submitInput();

		assert.equal(chatShellCommand, "npm test");
		assert.equal(interactiveShellCommand, undefined);
		assert.deepEqual(history, ["!npm test"]);
		assert.equal(inputEditor.text, "");
		assert.equal(clearDraftCalls, 1);
		assert.equal(submitCalls, 0);
		assert.deepEqual(entries, []);
	});

	it("keeps double-bang shell commands on the raw interactive terminal path", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("!!vim");
		const history: string[] = [];
		const entries: Array<{ kind: string; text: string }> = [];
		let chatShellCommand: string | undefined;
		let interactiveShellCommand: string | undefined;

		const controller = new AppInputActionController(
			{
				runtime: () => undefined,
				isRunning: () => true,
				isSessionSwitching: () => false,
				inputEditor: () => inputEditor,
				requestHistory: () => ({ add: (value: string) => history.push(value) }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => {},
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: (entry) => entries.push({ kind: entry.kind, text: "text" in entry ? entry.text : entry.output }),
				addSessionAbortedEntry: () => {},
				showToast: () => {},
				stopVoiceInput: async () => {},
				isShellCommandRunning: () => false,
				runChatShellCommand: async (command: string) => {
					chatShellCommand = command;
					return { exitCode: 0, signal: null };
				},
				sendShellInput: () => false,
				interruptShellCommand: () => false,
				runInteractiveShellCommand: async (command: string) => {
					interactiveShellCommand = command;
					return { exitCode: 0, signal: null };
				},
				stop: async () => {},
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => false } as unknown as AppPopupMenuController,
			{} as AppPopupActionController,
			{
				createSubmittedUserMessage: () => {
					throw new Error("shell command should not create a user message");
				},
				submitUserMessage: async () => {},
			} as unknown as AppQueuedMessageController,
		);

		await (controller as unknown as { submitInput(): Promise<void> }).submitInput();

		assert.equal(chatShellCommand, undefined);
		assert.equal(interactiveShellCommand, "vim");
		assert.deepEqual(history, ["!!vim"]);
		assert.equal(entries[0]?.kind, "system");
		assert.match(entries[0]?.text ?? "", /Shell command finished \(exit 0\): !!vim/u);
	});

	it("uses the editor as stdin while a chat shell command is running", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("yes");
		let clearDraftCalls = 0;
		let sentInput: string | undefined;
		let submitCalls = 0;

		const controller = new AppInputActionController(
			{
				runtime: () => undefined,
				isRunning: () => true,
				isSessionSwitching: () => false,
				inputEditor: () => inputEditor,
				requestHistory: () => ({ add: () => {} }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => {
					clearDraftCalls += 1;
				},
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: () => {},
				addSessionAbortedEntry: () => {},
				showToast: () => {},
				stopVoiceInput: async () => {},
				isShellCommandRunning: () => true,
				runChatShellCommand: async () => ({ exitCode: 0, signal: null }),
				sendShellInput: (text: string) => {
					sentInput = text;
					return true;
				},
				interruptShellCommand: () => false,
				runInteractiveShellCommand: async () => ({ exitCode: 0, signal: null }),
				stop: async () => {},
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => false } as unknown as AppPopupMenuController,
			{} as AppPopupActionController,
			{
				createSubmittedUserMessage: () => {
					throw new Error("shell stdin should not create a user message");
				},
				submitUserMessage: async () => {
					submitCalls += 1;
				},
			} as unknown as AppQueuedMessageController,
		);

		await (controller as unknown as { submitInput(): Promise<void> }).submitInput();

		assert.equal(sentInput, "yes");
		assert.equal(inputEditor.text, "");
		assert.equal(clearDraftCalls, 1);
		assert.equal(submitCalls, 0);
	});
	it("interrupts shell stdin and clears the editor before stopping", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("stdin payload");
		let clearDraftCalls = 0;
		let stopCalls = 0;
		const controller = new AppInputActionController(
			{
				runtime: () => undefined,
				isRunning: () => true,
				isSessionSwitching: () => false,
				inputEditor: () => inputEditor,
				requestHistory: () => ({ add: () => {} }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => { clearDraftCalls += 1; },
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: () => {},
				addSessionAbortedEntry: () => {},
				showToast: () => {},
				stopVoiceInput: async () => {},
				isShellCommandRunning: () => false,
				runChatShellCommand: async () => ({ exitCode: 0, signal: null }),
				sendShellInput: () => false,
				interruptShellCommand: () => true,
				runInteractiveShellCommand: async () => ({ exitCode: 0, signal: null }),
				stop: async () => { stopCalls += 1; },
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => false } as unknown as AppPopupMenuController,
			{} as AppPopupActionController,
			{ createSubmittedUserMessage: () => ({ id: "queued", promptText: "", displayText: "", images: [] }), submitUserMessage: async () => {} } as unknown as AppQueuedMessageController,
		);

		await controller.handleInterrupt();

		assert.equal(inputEditor.text, "");
		assert.equal(clearDraftCalls, 1);
		assert.equal(stopCalls, 0);
	});

	it("aborts compaction from Escape and restores session state afterward", async () => {
		let abortCompactionCalls = 0;
		const session = { isStreaming: false, isCompacting: true, abortCompaction: () => { abortCompactionCalls += 1; } };
		const controller = new AppInputActionController(
			{
				runtime: () => ({ session } as any),
				isRunning: () => true,
				isSessionSwitching: () => false,
				inputEditor: () => new InputEditor(),
				requestHistory: () => ({ add: () => {} }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => {},
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: () => {},
				addSessionAbortedEntry: () => {},
				showToast: () => {},
				stopVoiceInput: async () => {},
				isShellCommandRunning: () => false,
				runChatShellCommand: async () => ({ exitCode: 0, signal: null }),
				sendShellInput: () => false,
				interruptShellCommand: () => false,
				runInteractiveShellCommand: async () => ({ exitCode: 0, signal: null }),
				stop: async () => {},
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => false } as unknown as AppPopupMenuController,
			{} as AppPopupActionController,
			{ createSubmittedUserMessage: () => ({ id: "queued", promptText: "", displayText: "", images: [] }), submitUserMessage: async () => {} } as unknown as AppQueuedMessageController,
		);

		await controller.handleEscape();

		assert.equal(abortCompactionCalls, 1);
	});

	it("warns when submitting while a tab is still switching", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("hello tab");
		const toasts: string[] = [];
		const controller = new AppInputActionController(
			{
				runtime: () => undefined,
				isRunning: () => true,
				isSessionSwitching: () => true,
				inputEditor: () => inputEditor,
				requestHistory: () => ({ add: () => { throw new Error("should not record history"); } }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => {},
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: () => {},
				addSessionAbortedEntry: () => {},
				showToast: (message, kind) => { toasts.push(`${kind}:${message}`); },
				stopVoiceInput: async () => {},
				isShellCommandRunning: () => false,
				runChatShellCommand: async () => ({ exitCode: 0, signal: null }),
				sendShellInput: () => false,
				interruptShellCommand: () => false,
				runInteractiveShellCommand: async () => ({ exitCode: 0, signal: null }),
				stop: async () => {},
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => false } as unknown as AppPopupMenuController,
			{} as AppPopupActionController,
			{ createSubmittedUserMessage: () => ({ id: "queued", promptText: "", displayText: "", images: [] }), submitUserMessage: async () => {} } as unknown as AppQueuedMessageController,
		);

		await (controller as unknown as { submitInput(): Promise<void> }).submitInput();

		assert.deepEqual(toasts, ["info:Wait for the tab to finish loading"]);
		assert.equal(inputEditor.text, "hello tab");
	});

	it("cancels the active popup menu on Escape", async () => {
		let cancelCalls = 0;
		const controller = new AppInputActionController(
			{
				runtime: () => undefined,
				isRunning: () => true,
				isSessionSwitching: () => false,
				inputEditor: () => new InputEditor(),
				requestHistory: () => ({ add: () => {} }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => {},
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: () => {},
				addSessionAbortedEntry: () => {},
				showToast: () => {},
				stopVoiceInput: async () => {},
				isShellCommandRunning: () => false,
				runChatShellCommand: async () => ({ exitCode: 0, signal: null }),
				sendShellInput: () => false,
				interruptShellCommand: () => false,
				runInteractiveShellCommand: async () => ({ exitCode: 0, signal: null }),
				stop: async () => {},
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => "slash", cancelActivePopupMenu: () => { cancelCalls += 1; } } as unknown as AppPopupMenuController,
			{} as AppPopupActionController,
			{
				createSubmittedUserMessage: () => ({ id: "queued", promptText: "", displayText: "", images: [] }),
				submitUserMessage: async () => {},
			} as unknown as AppQueuedMessageController,
		);

		await controller.handleEscape();

		assert.equal(cancelCalls, 1);
	});

	it("delegates Enter to the active popup menu", async () => {
		let submitCalls = 0;
		let submitInputCalls = 0;
		const controller = new AppInputActionController(
			{
				runtime: () => undefined,
				isRunning: () => true,
				isSessionSwitching: () => false,
				inputEditor: () => new InputEditor(),
				requestHistory: () => ({ add: () => {} }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => {},
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: () => {},
				addSessionAbortedEntry: () => {},
				showToast: () => {},
				stopVoiceInput: async () => {},
				isShellCommandRunning: () => false,
				runChatShellCommand: async () => ({ exitCode: 0, signal: null }),
				sendShellInput: () => false,
				interruptShellCommand: () => false,
				runInteractiveShellCommand: async () => ({ exitCode: 0, signal: null }),
				stop: async () => {},
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => "slash" } as unknown as AppPopupMenuController,
			{ submitActivePopupMenu: async () => { submitCalls += 1; } } as unknown as AppPopupActionController,
			{ createSubmittedUserMessage: () => ({ id: "queued", promptText: "", displayText: "", images: [] }), submitUserMessage: async () => { submitInputCalls += 1; } } as unknown as AppQueuedMessageController,
		);

		controller.handleEnter();
		await new Promise((resolve) => setTimeout(resolve, 5));

		assert.equal(submitCalls, 1);
		assert.equal(submitInputCalls, 0);
	});

	it("shows a warning when shell stdin includes pasted images", async () => {
		const inputEditor = new InputEditor();
		inputEditor.attachImage("data", "image/png");
		inputEditor.insert("stdin payload");
		const toasts: string[] = [];
		let sentInput: string | undefined;
		const controller = new AppInputActionController(
			{
				runtime: () => undefined,
				isRunning: () => true,
				isSessionSwitching: () => false,
				inputEditor: () => inputEditor,
				requestHistory: () => ({ add: () => {} }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => {},
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: () => {},
				addSessionAbortedEntry: () => {},
				showToast: (message, kind) => toasts.push(`${kind}:${message}`),
				stopVoiceInput: async () => {},
				isShellCommandRunning: () => true,
				runChatShellCommand: async () => ({ exitCode: 0, signal: null }),
				sendShellInput: (text: string) => {
					sentInput = text;
					return true;
				},
				interruptShellCommand: () => false,
				runInteractiveShellCommand: async () => ({ exitCode: 0, signal: null }),
				stop: async () => {},
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => false } as unknown as AppPopupMenuController,
			{} as AppPopupActionController,
			{ createSubmittedUserMessage: () => ({ id: "queued", promptText: "", displayText: "", images: [] }), submitUserMessage: async () => {} } as unknown as AppQueuedMessageController,
		);

		await (controller as unknown as { submitInput(): Promise<void> }).submitInput();

		assert.equal(sentInput, undefined);
		assert.deepEqual(toasts, ["warning:Shell stdin cannot include pasted images"]);
		assert.notEqual(inputEditor.text, "");
	});

	it("records interactive shell failures as error entries", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("!!vim");
		const history: string[] = [];
		const entries: Array<{ kind: string; text: string }> = [];
		const controller = new AppInputActionController(
			{
				runtime: () => undefined,
				isRunning: () => true,
				isSessionSwitching: () => false,
				inputEditor: () => inputEditor,
				requestHistory: () => ({ add: (value: string) => history.push(value) }) as unknown as AppRequestHistory,
				clearPersistedInputDraft: async () => {},
				setStatus: () => {},
				setSessionStatus: () => {},
				setSessionActivity: () => {},
				addEntry: (entry) => entries.push({ kind: entry.kind, text: "text" in entry ? entry.text : entry.output }),
				addSessionAbortedEntry: () => {},
				showToast: () => {},
				stopVoiceInput: async () => {},
				isShellCommandRunning: () => false,
				runChatShellCommand: async () => ({ exitCode: 0, signal: null }),
				sendShellInput: () => false,
				interruptShellCommand: () => false,
				runInteractiveShellCommand: async () => ({ exitCode: null, signal: null, error: "no shell" }),
				stop: async () => {},
				requestRender: () => {},
			},
			{ syncActivePopupMenu: () => false } as unknown as AppPopupMenuController,
			{} as AppPopupActionController,
			{ createSubmittedUserMessage: () => ({ id: "queued", promptText: "", displayText: "", images: [] }), submitUserMessage: async () => {} } as unknown as AppQueuedMessageController,
		);

		await (controller as unknown as { submitInput(): Promise<void> }).submitInput();

		assert.deepEqual(history, ["!!vim"]);
		assert.equal(entries[0]?.kind, "error");
		assert.match(entries[0]?.text ?? "", /Shell command failed to start: !!vim/u);
	});

});
