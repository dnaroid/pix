import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { CreateAgentSessionServicesOptions } from "@earendil-works/pi-coding-agent";
import { logPixEvent } from "./logger.js";

type ResourceOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;

/** Add private, workspace-local rules after ordinary AGENTS.md / override discovery. */
export function projectAgentsResourceOptions(cwd: string, ignoreContextFiles: boolean): ResourceOptions {
	if (ignoreContextFiles) return { noContextFiles: true };
	const path = join(cwd, ".pi", "AGENTS.md");
	return {
		agentsFilesOverride: (base) => {
			try {
				if (!statSync(path).isFile()) return base;
				const content = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
				return { agentsFiles: [...base.agentsFiles, { path, content }] };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					logPixEvent("warn", "context:project-agents-read-failed", { path, error }, { project: cwd, module: "resources" });
				}
				return base;
			}
		},
	};
}
