import type { DesktopRegistryService } from "../registry/service.js";
import type { RegistryContext } from "../registry/context.js";
import { listSupervisorLaunchCommands, saveSupervisorLaunchCommand } from "./supervisor-launch-commands.js";
import type { SupervisorSetupRequest } from "./supervisor-setup-contract.js";
import type { SupervisorStore } from "./supervisor-store.js";

export async function configureSupervisorProject(options: {
	request: SupervisorSetupRequest;
	caller: string;
	ctx: RegistryContext;
	store: Pick<SupervisorStore, "readRegistry" | "readMandate">;
	registry: Pick<DesktopRegistryService, "action"> & Partial<Pick<DesktopRegistryService, "confirmedResource">>;
	current: () => boolean;
	exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
	signal: AbortSignal;
}) {
	const { request, caller, ctx, store, registry, current, signal, exclusive } = options;
	const { cwd } = ctx;
	const check = async (write: boolean) => {
		signal.throwIfAborted();
		if ((await store.readRegistry(cwd)).supervisorSessionId !== caller || !current()) {
			throw new Error("This runtime is no longer the project supervisor");
		}
		if (write) {
			const mandate = await store.readMandate(cwd);
			if (!mandate.enabled || mandate.paused) throw new Error("Enable and resume the supervisor before changing project settings");
		}
		if (!current()) throw new Error("The supervisor request is no longer active");
		signal.throwIfAborted();
	};
	const beforeCommit = () => check(true);
	await check(request.op !== "registry-list" && request.op !== "launch-list");
	switch (request.op) {
		case "registry-list": {
			const snapshot = await registry.action({ cwd, action: "refresh" }, ctx, signal);
			if (snapshot.error) throw new Error(snapshot.error);
			const filter = request.filter?.toLowerCase();
			const items = snapshot.items.filter((item) => item.type !== "project" && (!filter ||
				[item.name, item.type, item.description, ...item.tags ?? []].some((text) => text?.toLowerCase().includes(filter))));
			return {
				configured: snapshot.configured, total: items.length,
				items: items.slice(0, 100).map(({ type, name, status, description, publicationScope, actions }) => ({
					type, name, status, description: description?.slice(0, 300), publicationScope,
					actions: actions.filter((action) => action === "install" || action === "update"),
				})),
			};
		}
		case "registry-install": case "registry-update": {
			if (!registry.confirmedResource || !ctx.hasUI) throw new Error("Registry changes require confirmation in Pix Desktop");
			const { resourceType: type, name } = request;
			const result = await registry.confirmedResource({ type, name, action: request.op === "registry-install" ? "install" : "update" }, ctx, signal, beforeCommit, exclusive);
			return { type, name, result };
		}
		case "launch-list": return { commands: await listSupervisorLaunchCommands(cwd) };
		case "launch-add": case "launch-edit": return exclusive(async () => {
			await beforeCommit();
			return { saved: await saveSupervisorLaunchCommand(cwd, request, beforeCommit) };
		});
	}
}
