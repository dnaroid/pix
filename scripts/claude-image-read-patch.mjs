import { createHash, randomUUID } from "node:crypto";
import { open, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM_PROVIDER_SHA256 = "89f5b12d33757c4a663c4d7f16af7580a6dfca1d9f6d27d45d69ddc052511187";
const modulePath = fileURLToPath(new URL("../patches/claude-image-read/image-read-recovery.ts", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function patchedProvider(source) {
  if (digest(source) !== UPSTREAM_PROVIDER_SHA256) throw new Error("Unsupported provider.ts: expected characterized pi-claude-code-provider 0.5.0 source; refusing to patch");
  const changes = [
    ['const DEFAULT_MCP_READY_TIMEOUT_MS', 'import { IMAGE_READ_CORRECTION, PRIVATE_TRANSPORT_ERROR, onlyAttachedImageReads, recoverImageRead, type ImageReadAttempt } from "./image-read-recovery.ts";\n\nconst DEFAULT_MCP_READY_TIMEOUT_MS'],
    ['export function createClaudeStream(\n', `export function createClaudeStream(installation: ClaudeInstallation, dependencies: ClaudeStreamDependencies = {}) {
  return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    let resolvedOnce = false;
    let fixedSession: ReturnType<NonNullable<ClaudeStreamDependencies["resolveSession"]>>;
    const requestDependencies = { ...dependencies, resolveSession(request: SessionRequest) {
      if (!resolvedOnce) {
        fixedSession = dependencies.resolveSession?.(request);
        resolvedOnce = true;
      }
      return fixedSession;
    } };
    // One total wall-clock budget includes both attempts and preparation/cleanup.
    let configured: number;
    try { configured = timeoutSetting("PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS", DEFAULT_TOTAL_TIMEOUT_MS); }
    catch {
      // Preserve the upstream asynchronous error contract for invalid configuration.
      return createClaudeAttempt(installation, requestDependencies, {
        correction: false, onPrepared() {}, onRecoverable() {}, onSettled() {}, remainingTimeoutMs() { return undefined; },
      })(model, context, options);
    }
    const timeoutMs = Math.min(options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : configured, configured);
    return recoverImageRead((attempt, remainingOptions) =>
      createClaudeAttempt(installation, requestDependencies, attempt)(model, context, remainingOptions), { ...options, timeoutMs });
  };
}

function createClaudeAttempt(\n`],
    ['  dependencies: ClaudeStreamDependencies = {},\n) {', '  dependencies: ClaudeStreamDependencies = {},\n  imageReadAttempt: ImageReadAttempt,\n) {'],
    ['        const effectiveContext = await applyPayloadHook(model, requestContext, options);', `        const effectiveContext = await applyPayloadHook(model, requestContext, options);
        if (imageReadAttempt.correction) effectiveContext.systemPrompt = (effectiveContext.systemPrompt ?? "") + "\\n\\n" + IMAGE_READ_CORRECTION;`],
    ['        metrics.imageCount = prepared.imageCount;', '        metrics.imageCount = prepared.imageCount;\n        imageReadAttempt.onPrepared(prepared.imageCount > 0 || imageReadAttempt.correction);'],
    ['        const totalTimeoutMs = Math.min(requestedTotal, configuredTotal);', `        const totalTimeoutMs = Math.min(requestedTotal, configuredTotal, imageReadAttempt.remainingTimeoutMs() ?? Infinity);
        if (totalTimeoutMs <= 0) throw new ClaudeCodeError("timeout", "Claude Code request exhausted its total timeout before launch");`],
    ['        if (outcome.errorCategory) {', '        if (outcome.imageReadRecoverable && !options?.signal?.aborted) imageReadAttempt.onRecoverable();\n        if (outcome.errorCategory) {'],
    ['        await finalizeLifecycle();', '        try { await finalizeLifecycle(); } finally { imageReadAttempt.onSettled(); }'],
    ['  prepared: { directory: string; imageStoreDirectory?: string; violationPath?: string };', '  prepared: { directory: string; imageStoreDirectory?: string; violationPath?: string; attachmentPaths?: string[] };'],
    ['interface ExitOutcome {', 'interface ExitOutcome {\n  imageReadRecoverable?: boolean;'],
    ['      return fail("private_transport", true, "Claude Code proposed a Pi tool call against provider-private transport state");', `      const eligible = !mapper.isTerminal && isExpectedToolHandoffExit(result) && onlyAttachedImageReads(output, prepared.attachmentPaths ?? []);
      const outcome = await fail("private_transport", true, PRIVATE_TRANSPORT_ERROR);
      // A cleanup failure appends diagnostics: never recover it or hide it.
      outcome.imageReadRecoverable = eligible && output.errorMessage === PRIVATE_TRANSPORT_ERROR;
      return outcome;`],
  ];
  for (const [before, after] of changes) {
    if (source.split(before).length !== 2) throw new Error(`Patch anchor is not unique: ${before}`);
    source = source.replace(before, after);
  }
  return source;
}

/** Explicit target only; no credential/settings reads, discovery or implicit global installs. */
export async function applyClaudeImageReadPatch(directory, { check = false } = {}) {
  if (check) return installPatch(directory, true);
  const lockPath = join(directory, "src/.pix-image-read-patch.lock");
  const lock = await open(lockPath, "wx").catch((error) => {
    if (error.code === "EEXIST") throw new Error(`Patch installer already locked: ${lockPath}; only remove a stale lock after confirming its process is stopped`);
    throw error;
  });
  try {
    await lock.writeFile(`${process.pid}\n`);
    return await installPatch(directory, false);
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

async function installPatch(directory, check) {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (manifest.name !== "pi-claude-code-provider" || manifest.version !== "0.5.0") throw new Error("Expected pi-claude-code-provider 0.5.0; refusing to patch");
  const providerPath = join(directory, "src/provider.ts");
  const current = await readFile(providerPath, "utf8");
  const recovery = await readFile(modulePath, "utf8");
  const backup = join(directory, "src/.pix-original-provider.ts");
  let original = current;
  if (digest(current) !== UPSTREAM_PROVIDER_SHA256) original = await readFile(backup, "utf8").catch((error) => {
    if (error.code === "ENOENT") throw new Error("Provider has unrelated modifications and no original backup; refusing to overwrite");
    throw error;
  });
  const patched = patchedProvider(original);
  if (current !== original && current !== patched) throw new Error("Provider has unrelated modifications; refusing to overwrite");
  const target = join(directory, "src/image-read-recovery.ts");
  const existingRecovery = await readFile(target, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (check) {
    if (current !== patched || existingRecovery !== recovery) throw new Error("Image-read patch is not installed/current");
    return "current";
  }
  if (existingRecovery !== undefined && existingRecovery !== recovery) throw new Error("Recovery module has unrelated modifications; refusing to overwrite");
  if (current === original) await writeFile(backup, original, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  // Commit the importer last, so interrupted first installation cannot import a missing module.
  await atomicWrite(target, recovery);
  await atomicWrite(providerPath, patched);
  return "installed";
}

async function atomicWrite(target, content) {
  const temporary = `${target}.${randomUUID()}.pix-tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args[0] === "--check";
  if (check) args.shift();
  if (args.length !== 1) throw new Error("Usage: node scripts/claude-image-read-patch.mjs [--check] <installed-provider-directory>");
  console.log(await applyClaudeImageReadPatch(args[0], { check }));
}
