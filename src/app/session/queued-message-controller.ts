import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "../../input-editor.js";
import { createId } from "../id.js";
import { stringifyUnknown, submittedUserDisplayText } from "../rendering/message-content.js";
import type { Entry, SessionActivity, SubmittedUserMessage } from "../types.js";

export type AppQueuedMessageControllerHost = {
	runtime(): AgentSessionRuntime | undefined;
	requireRuntime(): AgentSessionRuntime;
	visibleEntries(): readonly Entry[];
	isRunning(): boolean;
	render(): void;
	addEntry(entry: Entry): void;
	addSessionAbortedEntry(): void;
	setStatus(status: string): void;
	setSessionStatus(session: AgentSession | undefined): void;
	setSessionActivity(activity: SessionActivity): void;
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	inputText(): string;
	resetRequestHistoryNavigation(): void;
	clearInput(): void;
	setInput(value: string): void;
	insertInput(value: string): void;
	attachImage(data: string, mimeType: string): void;
	prepareAutoThinkingForPrompt?(message: SubmittedUserMessage): { restore(): void } | undefined;
	onDeferredUserMessagesChanged?(): void;
};

export class AppQueuedMessageController {
	readonly deferredUserMessages: SubmittedUserMessage[] = [];

	private promptSubmissionInFlight = false;
	private flushingDeferredUserMessages = false;
	private immediateSendInProgress = false;

	constructor(private readonly host: AppQueuedMessageControllerHost) {}

	reset(): void {
		this.deferredUserMessages.length = 0;
		this.promptSubmissionInFlight = false;
		this.flushingDeferredUserMessages = false;
	}

	captureDeferredUserMessages(): SubmittedUserMessage[] {
		return this.deferredUserMessages.map((message) => this.cloneSubmittedUserMessage(message));
	}

	restoreDeferredUserMessages(messages: readonly SubmittedUserMessage[]): void {
		this.deferredUserMessages.length = 0;
		this.deferredUserMessages.push(...messages.map((message) => this.cloneSubmittedUserMessage(message)));
		this.updateQueuedMessageStatus();
	}

	createSubmittedUserMessage(promptText: string, displayText: string, images: ImageContent[]): SubmittedUserMessage {
		return {
			id: createId("queued-user"),
			promptText,
			displayText: submittedUserDisplayText(displayText, promptText, images),
			images,
		};
	}

	async submitUserMessage(message: SubmittedUserMessage): Promise<void> {
		const session = this.host.requireRuntime().session;
		if (session.isStreaming) {
			await this.sendUserMessageToSession(message, { streamingBehavior: "steer" });
			return;
		}

		if (this.shouldDeferUserMessage(session)) {
			this.deferUserMessage(message);
			return;
		}

		await this.sendUserMessageToSession(message);
	}

	async sendUserMessageToSession(
		message: SubmittedUserMessage,
		options: { streamingBehavior?: "steer" | "followUp" } = {},
	): Promise<void> {
		const session = this.host.requireRuntime().session;
		const markInFlight = !session.isStreaming;
		if (markInFlight) this.promptSubmissionInFlight = true;
		this.host.setSessionActivity("running");

		const autoThinking = this.host.prepareAutoThinkingForPrompt?.(message);
		try {
			const opts: { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] } = {};
			if (session.isStreaming) opts.streamingBehavior = options.streamingBehavior ?? "steer";
			if (message.images.length > 0) opts.images = message.images;
			await session.prompt(message.promptText, Object.keys(opts).length > 0 ? opts : undefined);
		} finally {
			autoThinking?.restore();
			if (markInFlight) this.promptSubmissionInFlight = false;

			const runtime = this.host.runtime();
			if (runtime) {
				const activeSession = runtime.session;
				this.host.setSessionStatus(activeSession);
				this.host.setSessionActivity(activeSession.isStreaming || activeSession.isCompacting ? "running" : "idle");
			}
			if (this.totalQueuedMessageCount() > 0) this.updateQueuedMessageStatus();
		}
	}

	async flushDeferredUserMessages(): Promise<void> {
		if (this.immediateSendInProgress || this.flushingDeferredUserMessages || this.deferredUserMessages.length === 0) return;

		const session = this.host.runtime()?.session;
		if (!session || session.isCompacting) return;
		if (!session.isStreaming && this.promptSubmissionInFlight) return;

		this.flushingDeferredUserMessages = true;
		try {
			while (this.deferredUserMessages.length > 0) {
				if (this.immediateSendInProgress) break;

				const activeSession = this.host.runtime()?.session;
				if (!activeSession || activeSession.isCompacting) break;
				if (!activeSession.isStreaming && this.promptSubmissionInFlight) break;

				const message = this.deferredUserMessages.shift();
				if (!message) break;
				this.notifyDeferredUserMessagesChanged();
				this.updateQueuedMessageStatus();

				try {
					await this.sendUserMessageToSession(message);
				} catch (error) {
					this.deferredUserMessages.unshift(message);
					this.notifyDeferredUserMessagesChanged();
					this.updateQueuedMessageStatus();
					this.host.addEntry({ id: createId("error"), kind: "error", text: `Queued message failed: ${stringifyUnknown(error)}` });
					break;
				}
			}
		} finally {
			this.flushingDeferredUserMessages = false;
			if (this.totalQueuedMessageCount() > 0) this.updateQueuedMessageStatus();
			if (this.host.isRunning()) this.host.render();
		}
	}

	queuedMessageCounts(): { steering: number; followUp: number } {
		const session = this.host.runtime()?.session;
		return {
			steering: (session?.getSteeringMessages().length ?? 0) + this.deferredUserMessages.length,
			followUp: session?.getFollowUpMessages().length ?? 0,
		};
	}

	totalQueuedMessageCount(): number {
		const { steering, followUp } = this.queuedMessageCounts();
		return steering + followUp;
	}

	updateQueuedMessageStatus(): void {
		if (this.totalQueuedMessageCount() === 0) this.host.setSessionStatus(this.host.runtime()?.session);
	}

	restoreQueuedMessagesToEditorForAbort(): number {
		const session = this.host.runtime()?.session;
		const sdkQueued = session?.clearQueue() ?? { steering: [], followUp: [] };
		const deferred = this.deferredUserMessages.splice(0);
		if (deferred.length > 0) this.notifyDeferredUserMessagesChanged();
		const restoredTexts = [
			...sdkQueued.steering,
			...deferred.map((message) => this.restorableSubmittedMessageText(message)),
			...sdkQueued.followUp,
		]
			.map((text) => text.trimEnd())
			.filter((text) => text.trim().length > 0);
		const images = deferred.flatMap((message) => message.images);
		const restoredCount = sdkQueued.steering.length + sdkQueued.followUp.length + deferred.length;

		if (restoredTexts.length > 0 || images.length > 0) {
			const currentText = this.host.inputText().trimEnd();
			const combinedText = [...restoredTexts, currentText]
				.filter((text) => text.trim().length > 0)
				.join("\n\n");

			this.host.setInput(combinedText);
			if (combinedText && images.length > 0) this.host.insertInput("\n");
			for (const image of images) this.host.attachImage(image.data, image.mimeType);
		}

		this.updateQueuedMessageStatus();
		return restoredCount;
	}

	async cancelQueuedMessage(entryId: string): Promise<void> {
		const entry = this.findQueuedEntry(entryId);
		if (!entry) throw new Error("Queued message is no longer available");

		await this.removeQueuedEntry(entry);
		this.updateQueuedMessageStatus();
		this.host.showToast("Queued message cancelled", "success");
	}

	async editQueuedMessage(entryId: string): Promise<void> {
		const entry = this.findQueuedEntry(entryId);
		if (!entry) throw new Error("Queued message is no longer available");

		const removed = await this.removeQueuedEntry(entry);
		this.host.resetRequestHistoryNavigation();
		if (typeof removed === "string") {
			this.host.clearInput();
			this.host.setInput(removed);
		} else {
			this.restoreSubmittedMessageToEditor(removed);
		}
		this.updateQueuedMessageStatus();
		this.host.showToast("Queued message moved to editor", "success");
	}

	async sendQueuedMessageImmediately(entryId: string): Promise<void> {
		const entry = this.findQueuedEntry(entryId);
		if (!entry) throw new Error("Queued message is no longer available");
		await this.sendQueuedEntryImmediately(entry);
	}

	private async sendQueuedEntryImmediately(entry: Extract<Entry, { kind: "queued" }>): Promise<void> {
		const session = this.host.requireRuntime().session;
		const shouldInterrupt = session.isStreaming || session.isCompacting;
		const taken = shouldInterrupt
			? this.takeQueuedEntryForInterruptedSend(entry, session)
			: { removed: await this.removeQueuedEntry(entry), sdkMessagesToRestore: undefined };

		this.updateQueuedMessageStatus();
		this.host.setStatus("sending queued message");
		this.host.render();

		this.immediateSendInProgress = true;
		try {
			if (shouldInterrupt) await this.interruptSessionForImmediateSend(session);
			if (taken.sdkMessagesToRestore) {
				await this.restoreSdkQueuedMessages(taken.sdkMessagesToRestore);
				taken.sdkMessagesToRestore = undefined;
			}

			const message = typeof taken.removed === "string"
				? this.createSubmittedUserMessage(taken.removed, taken.removed, [])
				: taken.removed;
			await this.sendUserMessageToSession(message, { streamingBehavior: "steer" });
			this.host.setSessionStatus(this.host.runtime()?.session);
			this.host.showToast("Queued message sent", "success");
		} catch (error) {
			if (taken.sdkMessagesToRestore) {
				try { await this.restoreSdkQueuedMessages(taken.sdkMessagesToRestore); } catch { /* best-effort rollback */ }
			}
			await this.requeueRemovedEntry(entry, taken.removed);
			this.updateQueuedMessageStatus();
			throw error;
		} finally {
			this.immediateSendInProgress = false;
			if (this.totalQueuedMessageCount() > 0) this.updateQueuedMessageStatus();
		}
	}

	findQueuedEntry(entryId: string): Extract<Entry, { kind: "queued" }> | undefined {
		const entry = this.host.visibleEntries().find((candidate) => candidate.id === entryId);
		return entry?.kind === "queued" ? entry : undefined;
	}

	private shouldDeferUserMessage(session: AgentSession): boolean {
		return session.isCompacting || this.promptSubmissionInFlight;
	}

	deferUserMessage(message: SubmittedUserMessage): void {
		this.deferredUserMessages.push(message);
		this.notifyDeferredUserMessagesChanged();
		this.updateQueuedMessageStatus();
		this.host.showToast("Message queued; send it from the queue menu or status button", "info");
		this.host.render();
	}

	private async rewriteSdkQueuedMessages<T>(update: (steering: string[], followUp: string[]) => T): Promise<T> {
		const session = this.host.requireRuntime().session;
		const originalSteering = [...session.getSteeringMessages()];
		const originalFollowUp = [...session.getFollowUpMessages()];
		const steering = [...originalSteering];
		const followUp = [...originalFollowUp];
		const result = update(steering, followUp);

		session.clearQueue();
		try {
			for (const text of steering) await session.steer(text);
			for (const text of followUp) await session.followUp(text);
		} catch (error) {
			session.clearQueue();
			for (const text of originalSteering) {
				try { await session.steer(text); } catch { /* best-effort rollback */ }
			}
			for (const text of originalFollowUp) {
				try { await session.followUp(text); } catch { /* best-effort rollback */ }
			}
			throw error;
		}

		return result;
	}

	private takeQueuedEntryForInterruptedSend(
		entry: Extract<Entry, { kind: "queued" }>,
		session: AgentSession,
	): { removed: string | SubmittedUserMessage; sdkMessagesToRestore: { steering: string[]; followUp: string[] } | undefined } {
		const sdkMessages = {
			steering: [...session.getSteeringMessages()],
			followUp: [...session.getFollowUpMessages()],
		};
		if (entry.queueSource === "deferred") {
			const [message] = this.deferredUserMessages.splice(entry.queueIndex, 1);
			if (!message) throw new Error("Queued message is no longer available");
			session.clearQueue();
			this.notifyDeferredUserMessagesChanged();
			return { removed: message, sdkMessagesToRestore: sdkMessages };
		}

		const messages = entry.queueSource === "sdk-steering" ? sdkMessages.steering : sdkMessages.followUp;
		const [removed] = messages.splice(entry.queueIndex, 1);
		if (removed === undefined) throw new Error("Queued message is no longer available");
		session.clearQueue();
		return { removed, sdkMessagesToRestore: sdkMessages };
	}

	private async restoreSdkQueuedMessages(messages: { steering: string[]; followUp: string[] }): Promise<void> {
		const session = this.host.requireRuntime().session;
		for (const text of messages.steering) await session.steer(text);
		for (const text of messages.followUp) await session.followUp(text);
	}

	private async interruptSessionForImmediateSend(session: AgentSession): Promise<void> {
		if (session.isCompacting) {
			this.host.setStatus("aborting compaction");
			session.abortCompaction();
			this.host.render();
		}

		if (session.isStreaming) {
			this.host.setStatus("aborting current response");
			this.host.addSessionAbortedEntry();
			this.host.render();
			await session.abort();
		}

		if (session.isCompacting) await this.waitForCompactionToStop(session);
		this.host.setSessionStatus(this.host.runtime()?.session);
		this.host.setSessionActivity(this.sessionActivity(this.host.runtime()?.session));
	}

	private async waitForCompactionToStop(session: AgentSession): Promise<void> {
		const startedAt = Date.now();
		while (session.isCompacting && this.host.runtime()?.session === session) {
			if (Date.now() - startedAt > 5000) throw new Error("Timed out waiting for compaction to abort");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 25);
				timer.unref?.();
			});
		}
	}

	private sessionActivity(session: AgentSession | undefined): SessionActivity {
		return session?.isStreaming || session?.isCompacting ? "running" : "idle";
	}

	private async removeQueuedEntry(entry: Extract<Entry, { kind: "queued" }>): Promise<string | SubmittedUserMessage> {
		if (entry.queueSource === "deferred") {
			const [message] = this.deferredUserMessages.splice(entry.queueIndex, 1);
			if (!message) throw new Error("Queued message is no longer available");
			this.notifyDeferredUserMessagesChanged();
			return message;
		}

		const removed = await this.rewriteSdkQueuedMessages((steering, followUp) => {
			const messages = entry.queueSource === "sdk-steering" ? steering : followUp;
			const [text] = messages.splice(entry.queueIndex, 1);
			return text;
		});
		if (removed === undefined) throw new Error("Queued message is no longer available");
		return removed;
	}

	private async requeueRemovedEntry(entry: Extract<Entry, { kind: "queued" }>, removed: string | SubmittedUserMessage): Promise<void> {
		if (entry.queueSource === "deferred") {
			if (typeof removed === "string") return;
			this.deferredUserMessages.splice(Math.min(entry.queueIndex, this.deferredUserMessages.length), 0, removed);
			this.notifyDeferredUserMessagesChanged();
			return;
		}

		if (typeof removed !== "string") return;
		await this.rewriteSdkQueuedMessages((steering, followUp) => {
			const messages = entry.queueSource === "sdk-steering" ? steering : followUp;
			messages.splice(Math.min(entry.queueIndex, messages.length), 0, removed);
		});
	}

	private restoreSubmittedMessageToEditor(message: SubmittedUserMessage): void {
		const text = this.restorableSubmittedMessageText(message);

		this.host.clearInput();
		if (text || message.images.length === 0) this.host.setInput(text || message.displayText);
		if (text && message.images.length > 0) this.host.insertInput("\n");
		for (const image of message.images) this.host.attachImage(image.data, image.mimeType);
	}

	private restorableSubmittedMessageText(message: SubmittedUserMessage): string {
		return message.images.length > 0
			? message.promptText.replace(/\[Image \d+(?:: [^\]]+)?\]\s*/g, "").trimEnd()
			: message.promptText.trimEnd();
	}

	private cloneSubmittedUserMessage(message: SubmittedUserMessage): SubmittedUserMessage {
		return {
			id: message.id,
			promptText: message.promptText,
			displayText: message.displayText,
			images: message.images.map((image) => ({ ...image })),
		};
	}

	private notifyDeferredUserMessagesChanged(): void {
		this.host.onDeferredUserMessagesChanged?.();
	}
}
