import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatOpencodeImportResult, notificationLevel, parseOpencodeImportCommandArgs } from "./commands";
import { importOpencodeAccounts } from "./importer";

export { formatOpencodeImportResult, notificationLevel, parseOpencodeImportCommandArgs } from "./commands";
export { getDefaultOpencodeAuthPath, importOpencodeAccounts } from "./importer";
export type { OpencodeImportOptions, OpencodeImportResult } from "./importer";

export default function opencodeImport(pi: ExtensionAPI): void {
	pi.registerCommand("opencode-import", {
		description: "Import supported OpenCode credentials and Antigravity accounts into Pi/Pix auth.json",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			let wroteAuth = false;
			try {
				const result = await importOpencodeAccounts(parseOpencodeImportCommandArgs(args));
				wroteAuth = result.wroteAuth;
				const message = formatOpencodeImportResult(result);
				if (ctx.ui?.notify) ctx.ui.notify(message, notificationLevel(result));
				else console.log(message);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.ui?.notify) ctx.ui.notify(message, "error");
				else console.error(message);
				return;
			}

			if (!wroteAuth) return;
			try {
				await ctx.reload();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`OpenCode credentials were imported, but resource reload failed: ${message}`);
			}
		},
	});
}
