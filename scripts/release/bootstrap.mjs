// @ts-nocheck
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = existsSync(join(scriptDir, "app", ".pix-portable.json"))
  ? join(scriptDir, "app")
  : resolve(scriptDir, "../..");
const home = homedir();
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function objectKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function opencodePaths() {
  const dataDir = process.env.OPENCODE_DATA_DIR?.trim()
    || join(process.env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "opencode");
  const configDir = process.env.OPENCODE_CONFIG_DIR?.trim()
    || join(process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "opencode");
  return {
    authPath: join(dataDir, "auth.json"),
    antigravityPath: join(configDir, "antigravity-accounts.json"),
  };
}

function codexAuthPath() {
  return join(process.env.CODEX_HOME?.trim() || join(home, ".codex"), "auth.json");
}

async function inspect() {
  const piAuthPath = join(agentDir, "auth.json");
  const piAuth = await readJson(piAuthPath);
  const { authPath: opencodeAuthPath, antigravityPath } = opencodePaths();
  let opencodeAuth;
  if (process.env.OPENCODE_AUTH_CONTENT?.trim()) {
    try {
      opencodeAuth = JSON.parse(process.env.OPENCODE_AUTH_CONTENT);
    } catch {
      opencodeAuth = undefined;
    }
  } else {
    opencodeAuth = await readJson(opencodeAuthPath);
  }
  const codexPath = codexAuthPath();
  const codexAuth = await readJson(codexPath);
  const codexTokens = codexAuth?.tokens;
  return {
    format: 1,
    pi: {
      agentDir,
      authPath: piAuthPath,
      providers: objectKeys(piAuth),
    },
    opencode: {
      authPath: process.env.OPENCODE_AUTH_CONTENT?.trim() ? "OPENCODE_AUTH_CONTENT" : opencodeAuthPath,
      authDetected: objectKeys(opencodeAuth).length > 0,
      providers: objectKeys(opencodeAuth),
      antigravityDetected: existsSync(antigravityPath),
      antigravityPath,
    },
    codex: {
      authPath: codexPath,
      apiKeyDetected: typeof codexAuth?.OPENAI_API_KEY === "string" && codexAuth.OPENAI_API_KEY.trim().length > 0,
      oauthDetected: Boolean(
        codexTokens
        && typeof codexTokens === "object"
        && (typeof codexTokens.refresh_token === "string" || typeof codexTokens.access_token === "string"),
      ),
      authMode: typeof codexAuth?.auth_mode === "string" ? codexAuth.auth_mode : undefined,
    },
  };
}

async function loadSuiteImporter() {
  const jitiEntry = [
    join(appRoot, "node_modules", "jiti", "lib", "jiti.mjs"),
    join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "jiti", "lib", "jiti.mjs"),
  ].find((candidate) => existsSync(candidate));
  if (!jitiEntry) throw new Error("Pix runtime is missing the TypeScript loader required by the tools suite.");
  const jitiModule = await import(pathToFileURL(jitiEntry).href);
  const jiti = jitiModule.createJiti(import.meta.url);
  return await jiti.import(join(appRoot, "external", "pi-tools-suite", "src", "opencode-import", "importer.ts"));
}

async function importOpenCode() {
  const { importOpencodeAccounts } = await loadSuiteImporter();
  const result = await importOpencodeAccounts({ overwrite: false });
  return {
    sourcePath: result.sourcePath,
    authPath: result.authPath,
    wroteAuth: result.wroteAuth,
    providers: result.providers.map(({ label, sourceProvider, targetProvider, status }) => ({
      label, sourceProvider, targetProvider, status,
    })),
    antigravity: result.antigravity,
  };
}

async function importCodexApiKey() {
  const sourcePath = codexAuthPath();
  const codexAuth = await readJson(sourcePath);
  const apiKey = typeof codexAuth?.OPENAI_API_KEY === "string" ? codexAuth.OPENAI_API_KEY.trim() : "";
  if (!apiKey) return { status: "source-missing", sourcePath, targetProvider: "openai" };

  const authModule = await import(pathToFileURL(join(
    appRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "core",
    "auth-storage.js",
  )).href);
  const store = authModule.AuthStorage.create(join(agentDir, "auth.json"));
  let status = "imported";
  await store.modify("openai", (current) => {
    if (current?.type === "api_key" && current.key === apiKey) {
      status = "already-imported";
      return undefined;
    }
    if (current) {
      status = "auth-exists";
      return undefined;
    }
    return { type: "api_key", key: apiKey };
  });
  return { status, sourcePath, targetProvider: "openai" };
}

export async function runBootstrapAction(action) {
  switch (action) {
    case "inspect": return await inspect();
    case "import-opencode": return await importOpenCode();
    case "import-codex-api-key": return await importCodexApiKey();
    default: throw new Error("Unknown Pix Desktop bootstrap action: " + action);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runBootstrapAction(process.argv[2] || "inspect");
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
