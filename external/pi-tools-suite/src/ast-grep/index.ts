import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAstGrepTool } from "./tool";

export default function astGrepExtension(pi: ExtensionAPI) {
	registerAstGrepTool(pi);
}
