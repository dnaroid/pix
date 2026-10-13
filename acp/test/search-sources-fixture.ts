import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Keep user-global Settings caches and provider slots out of the real user profile. */
export async function isolateSearchHome(root: string): Promise<() => void> {
  const previous = process.env.HOME;
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  return () => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; };
}

/** Explicit selection for tests of previously all-source behavior. Defaults have separate tests. */
export async function enableSearchSources(root: string): Promise<void> {
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi/search-sources.json"), JSON.stringify({ version: 1,
    enabled: { settings: true, code: true, knowledge: true, tasks: true, sessions: true, commits: true } }));
}
