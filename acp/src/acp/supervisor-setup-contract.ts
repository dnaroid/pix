export const SUPERVISOR_SETUP_OPS = ["registry-list", "registry-install", "registry-update", "launch-list", "launch-add", "launch-edit"] as const;
export const SUPERVISOR_SETUP_TIMEOUT_MS = 5 * 60_000;
export const SUPERVISOR_SETUP_CONFIRMATION_CANCELLED = "supervisor:setup-confirmation-cancelled";
export const SUPERVISOR_SETUP_SAVED = "supervisor:setup-saved";

export type SupervisorSetupRequest =
	| { op: "registry-list"; filter?: string }
	| { op: "registry-install" | "registry-update"; resourceType: "skill" | "agent"; name: string }
	| { op: "launch-list" }
	| { op: "launch-add"; name: string; command: string }
	| { op: "launch-edit"; commandId: string; revision: string; name?: string; command?: string };

export function isSupervisorSetupOp(op: unknown): op is SupervisorSetupRequest["op"] {
	return SUPERVISOR_SETUP_OPS.includes(op as SupervisorSetupRequest["op"]);
}

export function parseSupervisorSetupRequest(row: Record<string, unknown>): SupervisorSetupRequest | undefined {
	const { op } = row;
	if (!isSupervisorSetupOp(op)) return;
	const only = (...keys: string[]) => {
		if (Object.keys(row).some((key) => key !== "op" && !keys.includes(key))) throw new Error(`Unexpected fields for supervisor ${op}`);
	};
	const string = (key: string, max: number) => {
		const value = row[key];
		if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`Invalid ${key} for supervisor ${op}`);
		return value;
	};
	switch (op) {
		case "registry-list":
			only("filter");
			return { op, ...(row.filter === undefined ? {} : { filter: string("filter", 256).trim() }) };
		case "registry-install": case "registry-update": {
			only("resourceType", "name");
			const { resourceType } = row;
			if (resourceType !== "skill" && resourceType !== "agent") throw new Error(`Invalid resourceType for supervisor ${op}`);
			return { op, resourceType, name: string("name", 256).trim() };
		}
		case "launch-list": only(); return { op };
		case "launch-add":
			only("name", "command");
			return { op, name: string("name", 256).trim(), command: string("command", 20_000) };
		case "launch-edit": {
			only("commandId", "revision", "name", "command");
			const revision = string("revision", 64);
			if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("Invalid Launch Command revision; use launch-list");
			if (row.name === undefined && row.command === undefined) throw new Error("launch-edit needs name or command");
			return { op, commandId: string("commandId", 256), revision,
				...(row.name === undefined ? {} : { name: string("name", 256).trim() }),
				...(row.command === undefined ? {} : { command: string("command", 20_000) }) };
		}
	}
}
