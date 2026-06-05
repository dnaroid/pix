import { basename } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Theme } from "../../theme.js";
import { GIT_BRANCH_CACHE_MS } from "../constants.js";
import { runProcess } from "../process.js";
import type { AppBlinkController } from "./blink-controller.js";
import type { SessionActivity } from "../types.js";
import { APP_ICONS } from "../icons.js";

const STATUS_DOT_BLINK_KEY = "status-dot";

export type AppStatusControllerHost = {
	readonly cwd: string;
	readonly theme: Theme;
	readonly blinkController: AppBlinkController;
	runtimeSession(): AgentSession | undefined;
	render(): void;
};

export class AppStatusController {
	private status = "starting";
	private statusFollowsSession = false;
	private gitBranchCache: { checkedAt: number; branch: string | undefined } | undefined;
	private gitBranchLookupInFlight = false;

	sessionActivity: SessionActivity = "idle";

	get statusDotBright(): boolean {
		return this.host.blinkController.visible(STATUS_DOT_BLINK_KEY, false);
	}

	constructor(private readonly host: AppStatusControllerHost) {}

	setStatus(status: string): void {
		this.status = status;
		this.statusFollowsSession = false;
	}

	setSessionStatus(session: AgentSession | undefined): void {
		this.statusFollowsSession = true;
		this.status = session ? this.formatSessionStatus(session) : "no session";
	}

	currentStatus(): string {
		if (!this.statusFollowsSession) return this.status;

		const session = this.host.runtimeSession();
		this.status = session ? this.formatSessionStatus(session) : "no session";
		return this.status;
	}

	setSessionActivity(activity: SessionActivity): void {
		if (this.sessionActivity === activity) return;

		this.sessionActivity = activity;

		if (activity === "idle") {
			this.stopStatusBlink();
			return;
		}

		this.startStatusBlink();
	}

	stopStatusBlink(): void {
		this.host.blinkController.setActive(STATUS_DOT_BLINK_KEY, false, {
			scope: "status-line",
			initialVisible: false,
		});
	}

	formatSessionStatus(session: AgentSession): string {
		return `${this.statusModelLabel(session)} ${APP_ICONS.lightbulb} ${this.statusThinkingLabel(session)} ${this.formatContextUsagePercent(session)}`;
	}

	statusModelLabel(session: AgentSession): string {
		return session.model ? `${session.model.provider}/${session.model.id}` : "no model";
	}

	statusThinkingLabel(session: AgentSession): string {
		return session.thinkingLevel;
	}

	statusSessionLabel(session: AgentSession): string {
		const name = session.sessionName?.trim();
		return name ? name : `session ${session.sessionId.slice(0, 8)}`;
	}

	statusWorkspaceLabel(): string {
		const folderName = basename(this.host.cwd) || this.host.cwd;
		const branchLabel = this.statusWorkspaceGitBranchLabel();
		return branchLabel ? `${folderName} ${branchLabel}` : folderName;
	}

	statusWorkspaceGitBranchLabel(): string | undefined {
		const branchName = this.currentGitBranchName();
		return branchName ? `(${branchName})` : undefined;
	}

	formatContextUsagePercent(session: AgentSession): string {
		const percent = this.roundedContextUsagePercent(session);
		return percent === undefined ? "?%" : `${percent.toString().padStart(2, " ")}%`;
	}

	roundedContextUsagePercent(session: AgentSession): number | undefined {
		const percent = session.getContextUsage()?.percent;
		return typeof percent === "number" && Number.isFinite(percent) ? Math.round(percent) : undefined;
	}

	contextUsagePercentColor(percent: number): string {
		if (percent <= 30) return this.host.theme.colors.success;
		if (percent <= 50) return this.host.theme.colors.warning;
		return this.host.theme.colors.error;
	}

	private currentGitBranchName(): string | undefined {
		const now = Date.now();
		if (this.gitBranchCache && now - this.gitBranchCache.checkedAt < GIT_BRANCH_CACHE_MS) {
			return this.gitBranchCache.branch;
		}

		if (!this.gitBranchLookupInFlight) {
			this.gitBranchLookupInFlight = true;
			void this.refreshGitBranchName();
		}

		return this.gitBranchCache?.branch;
	}

	private async refreshGitBranchName(): Promise<void> {
		const previous = this.gitBranchCache?.branch;
		try {
			const result = await runProcess("git", ["-C", this.host.cwd, "branch", "--show-current"], {
				timeoutMs: 150,
				maxBufferBytes: 1024,
			});
			const branch = result.status === 0 ? result.stdout.trim() || undefined : undefined;
			this.gitBranchCache = { checkedAt: Date.now(), branch };
			if (branch !== previous) this.host.render();
		} finally {
			this.gitBranchLookupInFlight = false;
		}
	}

	private startStatusBlink(): void {
		this.host.blinkController.setActive(STATUS_DOT_BLINK_KEY, true, {
			scope: "status-line",
			initialVisible: false,
			resetVisible: true,
		});
	}
}
