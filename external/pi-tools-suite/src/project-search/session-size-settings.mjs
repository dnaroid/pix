import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse } from "jsonc-parser";

// Protocol twin in ACP and the tools suite. This caps search work, not saved history.
export const SESSION_MAX_FILE_MIB = 64;
const MIB = 1024 * 1024;
export async function loadSessionMaxFileBytes(path = join(process.env.HOME?.trim() || homedir(), ".config/pi/pi-tools-suite.jsonc")) {
  const fallback = SESSION_MAX_FILE_MIB * MIB;
  try {
    for (const directory of [dirname(dirname(path)), dirname(path)]) {
      if (!(await lstat(directory)).isDirectory()) return fallback;
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MIB) return fallback;
      const buffer = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== info.size) return fallback;
      const errors = [];
      const value = parse(buffer.subarray(0, bytesRead).toString("utf8"), errors, { allowTrailingComma: true })?.search?.sessionMaxFileMiB;
      return !errors.length && Number.isInteger(value) && value >= 1 && value <= SESSION_MAX_FILE_MIB ? value * MIB : fallback;
    } finally { await file.close(); }
  } catch { return fallback; }
}
