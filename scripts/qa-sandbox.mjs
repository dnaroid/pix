import { fileURLToPath } from "node:url";
import { createQaWorkspace } from "./qa-workspace.mjs";

try {
  if (process.argv.length !== 2) throw new Error("usage: npm run qa:sandbox (creates a fresh disposable project)");
  console.log(JSON.stringify(await createQaWorkspace(fileURLToPath(new URL("../", import.meta.url))), null, 2));
} catch (error) {
  console.error(`qa:sandbox: ${error.message}`);
  process.exitCode = 1;
}
