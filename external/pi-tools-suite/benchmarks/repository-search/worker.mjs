import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { searchProject } from "../../src/project-search/engine.ts";
import { searchNative } from "../../src/project-search/native-engine.mjs";
import { searchNativeProject } from "../../src/project-search/native.ts";

const [root, requestFile] = process.argv.slice(2);
const request = JSON.parse(readFileSync(requestFile, "utf8"));
const exec = promisify(execFile);
if (request.coverage) {
  console.log(JSON.stringify(await searchNative(root, { query: request.query, sources: ["code", "knowledge"],
    mode: "semantic", limit: 10 })));
} else {
  let nativeStatus;
  const response = await searchProject(root, request, {
    native: async (...args) => {
      const result = await searchNativeProject(...args);
      nativeStatus = result.status;
      return result;
    },
    exec: async (command, args, options) => {
      try {
        const result = await exec(command, command === "idx" ? ["--no-auto-update", ...args] : args,
          { ...options, maxBuffer: 4 * 1024 * 1024 });
        return { ...result, code: 0 };
      } catch (error) {
        if (error.killed || error.name === "AbortError") throw error;
        return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? 1 };
      }
    },
  });
  console.log(JSON.stringify({ ...response, nativeStatus }));
}
