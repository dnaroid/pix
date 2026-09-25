import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LSP_ONBOARDING_CHANNEL,
  lspOnboardingDefinitionForFile,
  lspOnboardingProposalForFile,
  publishMissingLspSuggestion,
} from "../src/lsp/onboarding.js";

const tempDirs: string[] = [];
const previousHome = process.env.HOME;
const previousPiConfigDir = process.env.PI_CONFIG_DIR;
const previousBridge = process.env.PIX_ACP_SESSION_STATE_BRIDGE;

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function writeUserConfig(home: string, source: string): void {
  const directory = path.join(home, ".config", "pi");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "pi-tools-suite.jsonc"), source, "utf8");
}

beforeEach(() => {
  delete process.env.PI_CONFIG_DIR;
  delete process.env.PIX_ACP_SESSION_STATE_BRIDGE;
});

afterEach(() => {
  process.env.HOME = previousHome;
  if (previousPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
  else process.env.PI_CONFIG_DIR = previousPiConfigDir;
  if (previousBridge === undefined) delete process.env.PIX_ACP_SESSION_STATE_BRIDGE;
  else process.env.PIX_ACP_SESSION_STATE_BRIDGE = previousBridge;
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("LSP onboarding", () => {
  test("maps only languages with a trusted automatic installer", () => {
    expect(lspOnboardingDefinitionForFile("/project/src/main.rs")?.installerId).toBe("rust");
    expect(lspOnboardingDefinitionForFile("/project/src/App.svelte")?.installerId).toBe("svelte");
    expect(lspOnboardingDefinitionForFile("/project/README.md")).toBeUndefined();
    expect(lspOnboardingDefinitionForFile("/project/main.cpp")).toBeUndefined();
  });

  test("suggests only when no enabled registered LSP matches the edited language", async () => {
    const home = tempDir("pix-lsp-onboarding-home-");
    const project = tempDir("pix-lsp-onboarding-project-");
    process.env.HOME = home;
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    const rustFile = path.join(project, "src", "lib.rs");
    const pythonFile = path.join(project, "src", "main.py");
    fs.writeFileSync(rustFile, "fn main() {}\n");
    fs.writeFileSync(pythonFile, "print('hi')\n");
    writeUserConfig(home, "{\n  \"lsp\": {\n    \"servers\": [{\n      \"id\": \"rust\",\n      \"include\": [\"**/*.rs\"],\n      \"bin\": \"rust-analyzer\"\n    }]\n  }\n}\n");
    const ctx = { cwd: project } as any;

    expect(await lspOnboardingProposalForFile(ctx, rustFile)).toBeUndefined();
    expect((await lspOnboardingProposalForFile(ctx, pythonFile))?.installerId).toBe("python");
  });

  test("publishes a structured RPC session-state warning for a missing registered LSP", async () => {
    const home = tempDir("pix-lsp-onboarding-publish-home-");
    const project = tempDir("pix-lsp-onboarding-publish-project-");
    process.env.HOME = home;
    process.env.PIX_ACP_SESSION_STATE_BRIDGE = "1";
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    const file = path.join(project, "src", "main.py");
    fs.writeFileSync(file, "print('hi')\n");
    writeUserConfig(home, "{}\n");
    const widgets: Array<{ key: string; lines?: string[] }> = [];
    const ctx = {
      cwd: project,
      mode: "rpc",
      ui: {
        setWidget: (key: string, lines?: string[]) => widgets.push({ key, lines }),
      },
    } as any;

    await publishMissingLspSuggestion(ctx, file);

    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.key).toBe("pix.session-state");
    expect(widgets[0]?.lines?.join("\n")).toContain(LSP_ONBOARDING_CHANNEL);
    expect(widgets[0]?.lines?.join("\n")).toContain("\"installerId\":\"python\"");
  });
});
