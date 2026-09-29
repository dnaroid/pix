import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerModelTools from "../src/model-tools/index.js";
import { registerShellWorkdir } from "../src/model-tools/shell-workdir.js";

class FakePi {
  tools = new Map<string, any>();
  commands = new Map<string, any>();
  handlers = new Map<string, any[]>();
  activeTools: string[] = [];
  registerTool(tool: any) { this.tools.set(tool.name, tool); }
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  on(name: string, handler: any) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); }
  emit(name: string, ctx: any, event = {}) { for (const handler of this.handlers.get(name) ?? []) handler(event, ctx); }
  getActiveTools() { return this.activeTools; }
  setActiveTools(tools: string[]) { this.activeTools = tools; }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shell-workdir-")));
  roots.push(root);
  const workspacePath = path.join(root, "workspace");
  const extraPath = path.join(root, "extra");
  const otherPath = path.join(root, "other");
  for (const dir of [workspacePath, extraPath, otherPath, path.join(extraPath, "nested"), path.join(extraPath, "..notes")]) fs.mkdirSync(dir);
  // Use the same async realpath as the permission resolver: on Windows it can
  // expand an 8.3 temp alias that the sync realpath above retains.
  const workspace = await fs.promises.realpath(workspacePath);
  const extra = await fs.promises.realpath(extraPath);
  const other = await fs.promises.realpath(otherPath);
  const executed: string[] = [];
  const pi = new FakePi();
  registerModelTools(pi as any, {
    createBashToolDefinition: (cwd: string, options?: { spawnHook?: (context: { cwd: string }) => { cwd: string } }) => ({
      execute: async () => {
        executed.push(options?.spawnHook?.({ cwd })?.cwd ?? cwd);
        return { content: [{ type: "text", text: "ok" }], details: undefined };
      },
    }),
  } as any);
  const notices: Array<{ message: string; level: string }> = [];
  const context = (manager: object, cwd = workspace) => ({
    cwd, sessionManager: manager,
    ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
  });
  const command = (args: string, ctx: ReturnType<typeof context>) => pi.commands.get("shell-workdir").handler(args, ctx);
  const shell = (workdir: string, ctx: ReturnType<typeof context>) =>
    pi.tools.get("shell").execute("id", { command: "pwd", workdir }, undefined, undefined, ctx);
  return { root, workspace, extra, other, pi, notices, executed, context, command, shell };
}

async function denied(run: Promise<unknown>) {
  await expect(run).rejects.toThrow("Working directory escapes workspace");
}

describe("session shell workdir permissions", () => {
  test("allows only canonical granted directory and its descendants, then revokes", async () => {
    const { root, workspace, extra, other, pi, notices, executed, context, command, shell } = await fixture();
    const ctx = context({});
    pi.emit("session_start", ctx);
    await shell(workspace, ctx);
    await denied(shell(extra, ctx));
    await denied(shell(other, ctx));
    expect(executed).toEqual([workspace]);

    const alias = path.join(root, "extra link");
    fs.symlinkSync(extra, alias);
    await command(`allow ${alias}`, ctx);
    expect(notices.at(-1)?.message).toContain(`Shell workdir allowed: ${extra} (this session only`);
    await shell(path.join(alias, "nested"), ctx);
    expect(executed.at(-1)).toBe(path.join(extra, "nested"));
    await shell(path.join(alias, "..notes"), ctx);
    expect(executed.at(-1)).toBe(path.join(extra, "..notes"));
    await command("list", ctx);
    expect(notices.at(-1)?.message).toContain(`\n${extra}`);
    expect(notices.at(-1)?.message).not.toContain(alias);

    await command(`revoke ${alias}`, ctx);
    expect(notices.at(-1)?.message).toContain(`revoked: ${extra}`);
    await denied(shell(path.join(extra, "nested"), ctx));
    await denied(shell(other, ctx));
  });

  test("session replacement, reload, separate tabs, and child runtimes never inherit grants", async () => {
    const { extra, pi, context, command, shell } = await fixture();
    const first = context({});
    const second = context({});
    pi.emit("session_start", first);
    await command(`allow ${extra}`, first);
    await shell(extra, first);
    pi.emit("session_start", second);
    await shell(extra, first);
    await denied(shell(extra, second));
    pi.emit("session_shutdown", first);
    await denied(shell(extra, second));
    await denied(shell(extra, first));
    await command(`allow ${extra}`, second);
    pi.emit("session_start", second, { reason: "reload" });
    await denied(shell(extra, second));

    const child = await fixture();
    const childCtx = child.context({});
    child.pi.emit("session_start", childCtx);
    await denied(child.shell(extra, childCtx));
  });

  test("realpath prevents traversal and changed symlink targets from using a grant", async () => {
    const { workspace, extra, other, context, command, shell, notices, executed } = await fixture();
    const ctx = context({});
    const escape = path.join(workspace, "escape");
    fs.symlinkSync(extra, escape);
    await denied(shell(path.join(workspace, "..", "other"), ctx));
    await denied(shell(escape, ctx));
    await command(`allow ${extra}`, ctx);
    await shell(escape, ctx);
    fs.unlinkSync(escape);
    fs.symlinkSync(other, escape);
    await denied(shell(escape, ctx));
    expect(executed).toEqual([extra]);

    await command(`allow ${path.join(workspace, "missing")}`, ctx);
    expect(notices.at(-1)?.level).toBe("error");
    await command(`allow ${path.join(workspace, "missing-link")}`, ctx);
    expect(notices.at(-1)?.level).toBe("error");
    const file = path.join(workspace, "file");
    fs.writeFileSync(file, "not a directory");
    await command(`allow ${file}`, ctx);
    expect(notices.at(-1)?.message).toContain("Not a directory");
    await expect(shell(path.join(workspace, "missing"), ctx)).rejects.toThrow();
    await denied(shell(other, ctx));
  });

  test("revokes a removed canonical directory and reports invalid commands", async () => {
    const { extra, context, command, notices } = await fixture();
    const ctx = context({});
    await command(`allow ${extra}`, ctx);
    fs.rmSync(extra, { recursive: true });
    await command(`revoke ${extra}`, ctx);
    expect(notices.at(-1)?.message).toContain(`revoked: ${extra}`);
    await command(`revoke ${extra}`, ctx);
    expect(notices.at(-1)?.message).toContain(`was not allowed: ${extra}`);
    await command("allow", ctx);
    expect(notices.at(-1)?.message).toContain("Usage:");
  });

  test("an allow awaiting the filesystem cannot grant a replacement session", async () => {
    const { extra, context, notices } = await fixture();
    const pi = new FakePi();
    let release!: (value: boolean) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const resolveWorkdir = registerShellWorkdir(pi as any, {
      realpath: (name) => fs.promises.realpath(name),
      isDirectory: () => { started(); return new Promise<boolean>((resolve) => { release = resolve; }); },
    });
    const manager = {};
    const ctx = context(manager);
    pi.emit("session_start", ctx);
    const pending = pi.commands.get("shell-workdir").handler(`allow ${extra}`, ctx);
    await waiting;
    pi.emit("session_start", ctx, { reason: "new" });
    release(true);
    await pending;
    expect(notices.at(-1)?.message).toContain("session changed");
    await denied(resolveWorkdir(ctx as any, extra));
  });
});
