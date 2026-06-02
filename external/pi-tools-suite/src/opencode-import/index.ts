import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatOpencodeImportResult, notificationLevel, parseOpencodeImportCommandArgs } from "./commands";
import { importOpencodeAccounts } from "./importer";

export { formatOpencodeImportResult, notificationLevel, parseOpencodeImportCommandArgs } from "./commands";
export { getDefaultOpencodeAuthPath, importOpencodeAccounts } from "./importer";
export type { OpencodeImportOptions, OpencodeImportResult } from "./importer";

export default function opencodeImport(pi: ExtensionAPI): void {
	pi.registerCommand("opencode-import", {
		description: "Import opencode auth.json credentials and Antigravity accounts into Pi/Pix auth.json",
		handler: async (args: string, ctx: any) => {
			try {
				const result = await importOpencodeAccounts(parseOpencodeImportCommandArgs(args));
				const message = formatOpencodeImportResult(result);
				if (ctx.ui?.notify) ctx.ui.notify(message, notificationLevel(result));
				else console.log(message);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.ui?.notify) ctx.ui.notify(message, "error");
				else console.error(message);
			}
		},
	});
}
