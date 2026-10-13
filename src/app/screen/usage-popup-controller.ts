import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { colorize } from "../../theme.js";
import { resolveColor, resolveModelColor } from "../../config.js";
import type { AppToastAction } from "../rendering/toast-controller.js";
import { modelProviderThemeColor } from "../rendering/status-line-renderer.js";
import type { SessionSubagentUsage } from "../session/session-subagent-usage.js";
import { loadSessionUsageReport, type SessionUsageReport } from "../session/session-usage.js";
import { formatTuiAgentIcon, formatTuiCost, formatTuiSessionUsage, formatTuiSubagentUsage, tuiProviderUsageUrl } from "../session/session-usage-tui.js";
import { openFileLink as openSystemLink } from "./file-link-opener.js";
import type { AppMouseControllerHost } from "./mouse-controller.js";
import type { AppPopupMenuController } from "../popup/popup-menu-controller.js";

type UsageContext = {
	session: AgentSession;
	manager: AgentSession["sessionManager"];
	sessionId: string | undefined;
	tabGeneration: number;
	requestGeneration: number;
};

/** Click-driven usage UI; no provider request is made by merely opening it. */
export class UsagePopupController {
	private requestGeneration = 0;
	private toastId: number | undefined;
	private toastTabGeneration = -1;
	private toastSession: AgentSession | undefined;
	private failedRunPaths = new Set<string>();

	constructor(private readonly host: AppMouseControllerHost, private readonly menus: AppPopupMenuController) {}

	toggle(): void {
		if (this.toastId !== undefined && this.ownsVisibleToast() && this.host.toastEntry(this.toastId)) {
			this.requestGeneration++;
			this.dismiss();
			return;
		}
		const session = this.host.runtimeSession();
		if (!session) {
			this.show("Session usage\nNo session has started yet.");
			return;
		}
		const context: UsageContext = {
			session,
			manager: session.sessionManager,
			sessionId: session.sessionManager.getSessionId?.(),
			tabGeneration: this.host.tabsLifecycleGeneration(),
			requestGeneration: ++this.requestGeneration,
		};
		this.failedRunPaths.clear();
		this.refreshSpend(context);
	}

	/** Dismiss only this tab's Usage dialog on outside pointer activation. */
	dismissOnOutsideClick(usageTrigger: boolean, toastTargetId: number | undefined): boolean {
		const id = this.toastId;
		if (id === undefined || !this.ownsVisibleToast() || !this.host.toastEntry(id)) return false;
		if (usageTrigger || toastTargetId === id) return false;
		this.requestGeneration++;
		this.dismiss();
		return true;
	}

	private isCurrent(context: UsageContext): boolean {
		return this.requestGeneration === context.requestGeneration
			&& this.host.tabsLifecycleGeneration() === context.tabGeneration
			&& this.host.runtimeSession() === context.session
			&& context.session.sessionManager === context.manager
			&& context.manager.getSessionId?.() === context.sessionId;
	}

	private isVisible(): boolean {
		return this.toastId === undefined || (this.ownsVisibleToast() && this.host.toastEntry(this.toastId) !== undefined);
	}

	private ownsVisibleToast(): boolean {
		return this.toastTabGeneration === this.host.tabsLifecycleGeneration()
			&& this.toastSession === this.host.runtimeSession();
	}

	private dismiss(): void {
		const id = this.toastId;
		const owned = this.ownsVisibleToast();
		this.toastId = undefined;
		if (owned && id !== undefined && this.host.toastEntry(id)) this.host.dismissToast(id);
	}

	private show(message: string, actions: readonly AppToastAction[] = [], kind: "info" | "warning" = "info"): void {
		this.dismiss();
		const id = this.host.showToast(message, kind, { variant: "dialog", actions });
		this.toastId = typeof id === "number" ? id : undefined;
		this.toastTabGeneration = this.host.tabsLifecycleGeneration();
		this.toastSession = this.host.runtimeSession();
	}

	private refreshSpend(context: UsageContext, previous?: SessionUsageReport): void {
		this.show(previous ? this.sessionText(previous) + "\n\nRefreshing recorded usage…" : "Session usage\nLoading recorded usage…");
		void loadSessionUsageReport(context.session).then((report) => {
			if (!this.isCurrent(context) || !this.isVisible()) return;
			this.showSession(context, report);
		}, () => {
			if (!this.isCurrent(context) || !this.isVisible()) return;
			if (previous) this.showSession(context, previous, "Refresh failed. Showing last recorded snapshot.");
			else this.show("Session usage is unavailable.", [{ label: "Retry", onSelect: () => this.refreshSpend(context) }], "warning");
		});
	}

	private sessionText(report: SessionUsageReport): string {
		const theme = this.host.theme();
		const modelColors = this.host.modelColors();
		const quota = this.host.modelUsageStatus?.();
		return formatTuiSessionUsage(report, {
			...(quota ? { quota } : {}),
			formatModel: (provider, model) => {
				const configured = resolveModelColor(provider + "/" + model, modelColors);
				const foreground = configured ? resolveColor(configured, theme.colors) : modelProviderThemeColor(provider, theme.colors);
				return colorize(model, { foreground, bold: true });
			},
		});
	}

	private showSession(context: UsageContext, report: SessionUsageReport, warning?: string): void {
		if (!this.isCurrent(context)) return;
		const actions: AppToastAction[] = [];
		if (report.subagents) {
			actions.push({ label: "Subagents (" + report.subagents.agents.length + ")", onSelect: () => { void this.listSubagents(context, report); } });
		}
		if (report.providers.some(({ provider }) => tuiProviderUsageUrl(provider))) {
			actions.push({ label: "Provider pages", onSelect: () => { void this.openProviderMenu(context, report); } });
		}
		actions.push({ label: "Refresh spend", onSelect: () => this.refreshSpend(context, report) });
		if (context.session.model?.provider === "pi-claude-code-provider" && this.host.refreshModelUsage) {
			actions.push({ label: "Refresh limits", onSelect: () => { void this.refreshLimits(context, report); } });
		}
		this.show(this.sessionText(report) + (warning ? "\n\n" + warning : ""), actions, warning ? "warning" : "info");
	}

	private async listSubagents(context: UsageContext, report: SessionUsageReport): Promise<void> {
		if (!this.isCurrent(context)) return;
		const agents = report.subagents?.agents;
		if (!agents) {
			this.showSession(context, report);
			return;
		}
		if (!agents.length) {
			this.show("Subagent statistics\nNo recorded subagent runs in this session.", [
				{ label: "Usage", onSelect: () => this.showSession(context, report) },
			]);
			return;
		}
		const chosen = await this.menus.showSdkMenu(
			agents.map((agent) => ({
				value: agent.key,
				label: agent.agentId + "  " + formatTuiAgentIcon(agent) + " " + (agent.subagentType ?? "Type not recorded"),
				description: agent.usageRecorded
					? formatTuiCost(agent.totals, true) + " / " + agent.totals.totalTokens.toLocaleString("en-US") + " tokens"
					: "Usage not recorded",
			})),
			{ title: "Subagent statistics", placement: "center", searchable: true, preserveStatus: true },
		);
		if (!this.isCurrent(context)) return;
		const selected = agents.find((agent) => agent.key === chosen);
		if (selected) this.showAgent(context, report, selected);
		else this.showSession(context, report);
	}

	private showAgent(context: UsageContext, report: SessionUsageReport, agent: SessionSubagentUsage, warning?: string): void {
		if (!this.isCurrent(context)) return;
		const actions: AppToastAction[] = [
			{ label: "Agents", onSelect: () => { void this.listSubagents(context, report); } },
			{ label: "Usage", onSelect: () => this.showSession(context, report) },
		];
		if (agent.runDir && !this.failedRunPaths.has(agent.key)) {
			actions.push({ label: "Open run", onSelect: () => { void this.openRun(context, report, agent); } });
		}
		this.show(formatTuiSubagentUsage(agent) + (warning ? "\n\n" + warning : ""), actions, warning ? "warning" : "info");
	}

	private async openRun(context: UsageContext, report: SessionUsageReport, agent: SessionSubagentUsage): Promise<void> {
		if (!agent.runDir || !this.isCurrent(context)) return;
		this.show("Checking run directory…");
		let runPath: string | undefined;
		try {
			const workspace = this.host.cwd();
			if (!workspace) throw new Error("No active workspace");
			const root = await realpath(workspace);
			const target = await realpath(resolve(root, agent.runDir));
			const fromRoot = relative(root, target);
			if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(".." + sep) || isAbsolute(fromRoot)) throw new Error("Outside workspace");
			if (!(await stat(target)).isDirectory()) throw new Error("Not a directory");
			runPath = target;
		} catch { /* A missing/outside run is never opened. */ }
		if (!this.isCurrent(context) || !this.isVisible()) return;
		if (!runPath) {
			this.failedRunPaths.add(agent.key);
			this.showAgent(context, report, agent, "Run directory is unavailable or outside the workspace.");
			return;
		}
		const url = pathToFileURL(runPath).href;
		const link = { url, filePath: runPath, start: 0, end: 0 };
		const opened = this.host.openFileLink ? this.host.openFileLink(link) : openSystemLink(link);
		if (opened) this.showSession(context, report);
		else this.showAgent(context, report, agent, "Could not open run directory.");
	}

	private async openProviderMenu(context: UsageContext, report: SessionUsageReport): Promise<void> {
		if (!this.isCurrent(context)) return;
		const available = report.providers.flatMap(({ provider }) => {
			const url = tuiProviderUsageUrl(provider);
			return url ? [{ value: url, label: provider, description: "Open account usage in browser" }] : [];
		});
		const selected = await this.menus.showSdkMenu(available, {
			title: "Provider usage pages", placement: "center", preserveStatus: true, searchable: false,
		});
		if (!this.isCurrent(context)) return;
		if (!selected) {
			this.showSession(context, report);
			return;
		}
		const link = { url: selected, start: 0, end: 0 };
		const opened = this.host.openFileLink ? this.host.openFileLink(link) : openSystemLink(link);
		this.showSession(context, report, opened ? undefined : "Could not open usage page. Select Provider pages to retry.");
	}

	private async refreshLimits(context: UsageContext, report: SessionUsageReport): Promise<void> {
		if (!this.isCurrent(context)) return;
		const started = this.host.refreshModelUsage?.();
		if (!started || started.kind === "unsupported") {
			this.showSession(context, report, "Rate-limit refresh is unavailable for this model.");
			return;
		}
		if (started.kind === "in-flight") {
			this.showSession(context, report, "Rate-limit refresh is already running.");
			return;
		}
		this.show(this.sessionText(report) + "\n\nRefreshing provider limits…");
		const outcome = await started.promise;
		if (!this.isCurrent(context) || !this.isVisible()) return;
		this.showSession(context, report, outcome === "refreshed" ? undefined : "Could not refresh provider limits.");
	}
}
