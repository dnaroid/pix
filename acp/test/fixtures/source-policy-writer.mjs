// Real child-process crash barriers around the production policy rename.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [moduleUrl, root, source, value, phase] = process.argv.slice(2);
const proceed = new Promise(resolve => process.once("message", resolve));
const rename = fs.promises.rename;
fs.promises.rename = async (from, to) => {
  if (to === join(root, ".pi/search-sources.json") && phase === "before") {
    process.send({ event: "barrier" });
    await proceed;
  }
  const result = await rename(from, to);
  if (to === join(root, ".pi/search-sources.json") && phase === "after") {
    process.send({ event: "barrier" });
    await proceed;
  }
  return result;
};
syncBuiltinESMExports();
try {
  const { writeSourcePolicy } = await import(moduleUrl);
  const policy = await writeSourcePolicy(root, source, value === "true");
  process.send({ event: "done", policy });
} catch (error) {
  process.send({ event: "error", message: error.message });
  process.exitCode = 1;
} finally {
  process.disconnect();
}
