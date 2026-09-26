// Opt-in offline macOS experiment (PI_OFFLINE_COALITION_PROBE=1), continuing
// the launchd coalition / audit-token feasibility family. It adds the missing
// joint owner-loss case: after both the simulated application (A) and helper
// (B) are killed, a known fake descendant that setsid()+exec()s into its own
// session (C) survives — launchd does not clean it — and an *independent*
// recovery owner (R, a temporary UUID-labelled one-shot launchd job in the gui
// domain, structurally outside the A/B lineage) removes C before C's own
// independent alarm watchdog, using generation-safe audit-token signals only.
//
// What survives joint loss: C (escaped, reparented to launchd) and R
// (launchd-bootstrapped). What dies: A (harness's direct child) and B (A's
// direct waitable child, killed by A on a marker-file command).
//
// Stated limitation: the actors are cooperating fixtures that publish their
// own kernel-issued audit tokens; no PID enumeration or unvalidated PID/group
// kill exists anywhere, so recovery cannot discover hostile descendants that
// never publish a token. Teardown boots out only the exact UUID service,
// verifies `launchctl print` misses it, and ps-scans only the recorded R and C
// PIDs (existence only, never a signal); owned artifacts are retained whenever
// cleanup or the experiment is ambiguous.
//
// The second test adds the bounded restart case: the first recovery owner R1
// is SIGKILLed by exact UUID job control (never a numeric PID signal from
// the harness) while it is parked
// pre-cleanup on a gate the harness never opens, is independently confirmed
// absent (service lookup 113 plus existence-only ps), and the escaped C is
// observed alive after R1's removal. A fresh R2 — a new UUID-labelled one-shot
// job, structurally without R1's memory or IPC — then reconstructs the target
// solely from the persisted authentic checkpoint files and performs the same
// exact-token cleanup, with its receipt and an independent ps absence both
// observed before C's watchdog and before `finally`. The post-kill/pre-receipt
// idempotent restart (R1 dying after killing C but before its receipt) is
// deliberately not exercised; R2 rejects an already-dead target rather than
// treating it as successful idempotent recovery.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const launchctl = (args: string[], timeout = 4000) => spawnSync("launchctl", args, { timeout, encoding: "utf8" });
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const psOf = (pids: number[]) => spawnSync("ps", ["-p", pids.filter(p => p > 0).join(","), "-o", "pid="], { timeout: 4000, encoding: "utf8" });
const leafIsAlive = (pid: number) => {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { timeout: 4000, encoding: "utf8" });
  if (result.error || result.signal || result.stderr.trim()) throw new Error(`ps failed: ${result.error?.message ?? result.signal ?? result.stderr}`);
  if (result.status === 1 && result.stdout.trim() === "") return false;
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`ambiguous ps result: ${result.status} ${result.stderr}`);
  return !result.stdout.trim().startsWith("Z");
};
const actorsAreAbsent = (pids: number[]) => {
  const result = psOf(pids);
  if (result.error || result.signal || result.stderr.trim()) throw new Error(`ps failed: ${result.error?.message ?? result.signal ?? result.stderr}`);
  if (result.status === 0 && result.stdout.trim()) return false;
  if (result.status === 1 && result.stdout.trim() === "") return true;
  throw new Error(`ambiguous ps result: ${result.status} ${result.stderr}`);
};

async function waitFor(predicate: () => boolean, deadlineMs: number, what: string) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`deadline waiting for ${what}`);
}

type Checkpoint = { role: string; pid: number; pidversion: number; start: number; deadline: number };
const parseCp = (path: string): Checkpoint => {
  const text = readFileSync(path, "utf8");
  const m = text.match(/role=(\S+) pid=(\d+) pidversion=(\d+) token=[0-9a-f]{64} start=(\d+) deadline=(\d+)/);
  if (!m) throw new Error(`unparseable checkpoint ${path}: ${text}`);
  return { role: m[1], pid: Number(m[2]), pidversion: Number(m[3]), start: Number(m[4]), deadline: Number(m[5]) };
};
const parseReceipt = (path: string) =>
  Object.fromEntries([...readFileSync(path, "utf8").matchAll(/([a-z_]+)=(\S+)/g)].map(m => [m[1], m[2]]));

// Restart test only; the baseline test keeps its inline plist. The optional
// generation argument selects generation-suffixed supervisor artifacts.
const supervisorPlist = (label: string, supervisorBin: string, dir: string, gen?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${escapeXml(label)}</string><key>ProgramArguments</key><array><string>${escapeXml(supervisorBin)}</string><string>${escapeXml(dir)}</string>${gen ? `<string>${escapeXml(gen)}</string>` : ""}</array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${escapeXml(join(dir, "job.out"))}</string><key>StandardErrorPath</key><string>${escapeXml(join(dir, "job.err"))}</string></dict></plist>`;

test.skipIf(process.platform !== "darwin" || process.env.PI_OFFLINE_COALITION_PROBE !== "1")("independent launchd recovery supervisor cleans the setsid descendant after joint app/helper loss", async () => {
  const domain = `gui/${process.getuid!()}`;
  const access = launchctl(["print", domain]);
  if (access.status !== 0) throw new Error(`No user-domain launchd access: ${access.stderr}`);
  const dir = mkdtempSync(join(tmpdir(), "pi-recovery-owner-loss-"));
  const label = `org.pix.offline-recovery-probe.${randomUUID()}`;
  const service = `${domain}/${label}`;
  const plist = join(dir, "job.plist");
  const receiptPath = join(dir, "receipt.json");
  const compile = (source: string, out: string) =>
    spawnSync("xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", join(import.meta.dir, source), "-lbsm", "-o", out], { timeout: 20_000, encoding: "utf8" });
  let registered = false;
  let bootstrapped = false;
  let ok = false;
  let actors: number[] = [];
  let app: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const actorsBin = join(dir, "actors");
    const supervisorBin = join(dir, "supervisor");
    const actorsCompile = compile("fixtures/recovery-actors.c", actorsBin);
    expect(actorsCompile.status, actorsCompile.stderr || actorsCompile.error?.message).toBe(0);
    const supervisorCompile = compile("fixtures/recovery-supervisor.c", supervisorBin);
    expect(supervisorCompile.status, supervisorCompile.stderr || supervisorCompile.error?.message).toBe(0);

    app = Bun.spawn([actorsBin, "app", dir], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const cp = (role: string) => parseCp(join(dir, `${role}.json`));
    await waitFor(() => existsSync(join(dir, "app.json")) && existsSync(join(dir, "helper.json")) && existsSync(join(dir, "leaf.json")), 8000, "actor checkpoints");
    const appCp = cp("app");
    const helperCp = cp("helper");
    const leafCp = cp("leaf");

    // The fake descendant escaped via setsid+exec before any owner died: it
    // leads its own process group, distinct from the app's inherited group.
    const psInfo = (pid: number, keywords: string[]) =>
      spawnSync("ps", ["-p", String(pid), ...keywords.map(k => `-o ${k}=`)], { timeout: 4000, encoding: "utf8" });
    const leafPre = psInfo(leafCp.pid, ["pgid"]);
    expect(leafPre.status, leafPre.stderr).toBe(0);
    const leafPgid = Number(leafPre.stdout.trim());
    const appPre = psInfo(appCp.pid, ["pgid"]);
    expect(appPre.status, appPre.stderr || appPre.error?.message).toBe(0);
    const appPgid = Number(appPre.stdout.trim());
    expect(appPgid).toBeGreaterThan(0);
    expect(leafPgid, `leaf pgid ${leafPgid} must be its own pid (setsid+exec escaped)`).toBe(leafCp.pid);
    expect(leafPgid === appPgid, `leaf pgid ${leafPgid} must differ from app pgid ${appPgid}`).toBe(false);

    // Independent recovery owner: launchd child, outside the A/B lineage.
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${escapeXml(label)}</string><key>ProgramArguments</key><array><string>${escapeXml(supervisorBin)}</string><string>${escapeXml(dir)}</string></array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${escapeXml(join(dir, "job.out"))}</string><key>StandardErrorPath</key><string>${escapeXml(join(dir, "job.err"))}</string></dict></plist>`);
    const bootstrap = launchctl(["bootstrap", domain, plist]);
    // Even a failed bootstrap might have installed the job: bootout exact identity in finally.
    registered = true;
    expect(bootstrap.status, bootstrap.stderr || bootstrap.error?.message).toBe(0);
    bootstrapped = true;
    await waitFor(() => existsSync(join(dir, "r.json")), 5000, "supervisor checkpoint");
    const supervisorCp = cp("r");
    actors = [leafCp.pid, supervisorCp.pid];

    // Joint loss: A removes its direct waitable helper, then the harness kills
    // its directly owned A. Both actors are observed dead via their killers.
    writeFileSync(join(dir, "kill-helper"), "1\n");
    await waitFor(() => existsSync(join(dir, "helper-killed.json")), 5000, "helper kill handshake");
    const helperKilled = readFileSync(join(dir, "helper-killed.json"), "utf8").match(/pid=(\d+) signal=(\d+) errno=(\d+)/);
    expect(helperKilled?.[1], "helper-killed marker must name B").toBe(String(helperCp.pid));
    expect(helperKilled?.[2], "B must die by SIGKILL").toBe("9");
    app!.kill(9);
    await app!.exited;
    expect(app!.signalCode).toBe("SIGKILL");

    // Survival proof, ordered before recovery: C still exists after both owners
    // died, orphaned to launchd (ppid 1) — launchd did not clean it up.
    expect(leafIsAlive(leafCp.pid), "C must still be running before recovery").toBe(true);
    const leafOrphan = psInfo(leafCp.pid, ["ppid"]);
    expect(leafOrphan.status, leafOrphan.stderr).toBe(0);
    expect(Number(leafOrphan.stdout.trim()), "survivor must be reparented to launchd").toBe(1);

    // Arm recovery; R must clean C before C's independent alarm watchdog.
    const tGate = Date.now();
    writeFileSync(join(dir, "gate"), "1\n");
    await waitFor(() => existsSync(receiptPath), 10_000, "recovery receipt");
    const tReceipt = Date.now();
    const receipt = parseReceipt(receiptPath);
    expect(receipt.status, `recovery receipt: ${JSON.stringify(receipt)}`).toBe("ok");
    expect(receipt.stage).toBe("recovery");
    expect(Number(receipt.leaf_pid)).toBe(leafCp.pid);
    expect(Number(receipt.owner_probe), "A's stale token must report ESRCH").toBe(3);
    expect(Number(receipt.helper_probe), "B's stale token must report ESRCH").toBe(3);
    expect(Number(receipt.alive_before_kill), "R must observe the authentic C generation alive").toBe(1);
    expect(Number(receipt.kill_return), "exact-generation SIGKILL must succeed").toBe(0);
    expect(Number(receipt.gone), "R must confirm C gone via exact-token probe").toBe(1);
    expect(tReceipt - tGate, `recovery took ${tReceipt - tGate}ms after gate`).toBeLessThanOrEqual(10_500);
    expect(Number(receipt.recovered_at), "R's receipt must precede C's watchdog").toBeLessThan(leafCp.deadline);
    expect(leafCp.deadline - Number(receipt.recovered_at), "recovery must beat the independent watchdog with margin").toBeGreaterThan(5);

    // Independent existence confirmation of the recovery (no signal, no re-wait on R).
    await waitFor(() => actorsAreAbsent([leafCp.pid]), 5000, "leaf absence after recovery");
    ok = true;
    console.log(`joint_loss_recovered=1 leaf_pid=${leafCp.pid} supervisor_pid=${supervisorCp.pid} recovered_at=${receipt.recovered_at} leaf_backstop=${leafCp.deadline} gate_to_receipt_ms=${tReceipt - tGate} label=${label}`);
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) {
      app.kill(9);
      await app.exited;
    }
    let cleaned = false;
    if (registered) {
      const bootout = launchctl(["bootout", service]);
      const scan = launchctl(["print", service]);
      const processScan = actors.length ? psOf(actors) : null;
      // Ambiguous registration or surviving recorded PIDs retain the owned dir.
      cleaned = !scan.error && !bootout.error && scan.status === 113 && bootstrapped && bootout.status === 0 &&
        !!processScan && !processScan.error && !processScan.signal && processScan.status === 1 &&
        processScan.stdout.trim() === "" && processScan.stderr.trim() === "";
      console.log(`cleanup_service=${service} bootout=${bootout.status} print=${scan.status} actor_ps=${processScan?.status ?? "not-recorded"} actor_pids=${actors.join(",")}`);
      if (!cleaned) console.error(`RESIDUAL_JOB=${service} bootout=${bootout.status} ${bootout.stderr} print=${scan.stdout}`);
    } else cleaned = true;
    if (cleaned && ok) rmSync(dir, { recursive: true, force: true });
    else console.error(`RETAINED_RUN_DIR=${dir} cleaned=${cleaned} ok=${ok}`);
    expect(cleaned, `launchd job still present: ${service}; owned files retained ${dir}`).toBe(true);
  }
}, 120_000);

test.skipIf(process.platform !== "darwin" || process.env.PI_OFFLINE_COALITION_PROBE !== "1")("restart: fresh launchd R2 rebuilds the target from persisted checkpoints after R1 is killed before cleanup", async () => {
  const domain = `gui/${process.getuid!()}`;
  const access = launchctl(["print", domain]);
  if (access.status !== 0) throw new Error(`No user-domain launchd access: ${access.stderr}`);
  const dir = mkdtempSync(join(tmpdir(), "pi-recovery-restart-"));
  const mkJob = (gen: string) => {
    const label = `org.pix.offline-recovery-probe.${randomUUID()}`;
    return { gen, label, service: `${domain}/${label}`, plist: join(dir, `job-${gen}.plist`) };
  };
  const jobs = { r1: mkJob("a"), r2: mkJob("b") };
  const compile = (source: string, out: string) =>
    spawnSync("xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", join(import.meta.dir, source), "-lbsm", "-o", out], { timeout: 20_000, encoding: "utf8" });
  const cp = (role: string) => parseCp(join(dir, `${role}.json`));
  const psInfo = (pid: number, keywords: string[]) =>
    spawnSync("ps", ["-p", String(pid), ...keywords.map(k => `-o ${k}=`)], { timeout: 4000, encoding: "utf8" });
  const registered = { r1: false, r2: false };
  const bootstrapped = { r1: false, r2: false };
  // Set only after the mid-test bootout returned 0 AND the exact service lookup reported absence.
  let r1EarlyRemoved = false;
  let actors: number[] = [];
  let app: ReturnType<typeof Bun.spawn> | null = null;
  let ok = false;
  try {
    const actorsBin = join(dir, "actors");
    const supervisorBin = join(dir, "supervisor");
    const actorsCompile = compile("fixtures/recovery-actors.c", actorsBin);
    expect(actorsCompile.status, actorsCompile.stderr || actorsCompile.error?.message).toBe(0);
    const supervisorCompile = compile("fixtures/recovery-supervisor.c", supervisorBin);
    expect(supervisorCompile.status, supervisorCompile.stderr || supervisorCompile.error?.message).toBe(0);

    app = Bun.spawn([actorsBin, "app", dir], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    await waitFor(() => existsSync(join(dir, "app.json")) && existsSync(join(dir, "helper.json")) && existsSync(join(dir, "leaf.json")), 8000, "actor checkpoints");
    const appCp = cp("app");
    const helperCp = cp("helper");
    const leafCp = cp("leaf");

    // Same escape proof as the baseline: C leads its own group, distinct from
    // the app's inherited group, before any owner dies.
    const leafPre = psInfo(leafCp.pid, ["pgid"]);
    expect(leafPre.status, leafPre.stderr).toBe(0);
    const leafPgid = Number(leafPre.stdout.trim());
    const appPre = psInfo(appCp.pid, ["pgid"]);
    expect(appPre.status, appPre.stderr || appPre.error?.message).toBe(0);
    const appPgid = Number(appPre.stdout.trim());
    expect(appPgid).toBeGreaterThan(0);
    expect(leafPgid, `leaf pgid ${leafPgid} must be its own pid (setsid+exec escaped)`).toBe(leafCp.pid);
    expect(leafPgid === appPgid, `leaf pgid ${leafPgid} must differ from app pgid ${appPgid}`).toBe(false);

    // R1: first-generation recovery owner, generation "a".
    writeFileSync(jobs.r1.plist, supervisorPlist(jobs.r1.label, supervisorBin, dir, jobs.r1.gen));
    const bootstrap1 = launchctl(["bootstrap", domain, jobs.r1.plist]);
    // Even a failed bootstrap might have installed the job: bootout exact identity in finally.
    registered.r1 = true;
    expect(bootstrap1.status, bootstrap1.stderr || bootstrap1.error?.message).toBe(0);
    bootstrapped.r1 = true;
    await waitFor(() => existsSync(join(dir, "r-a.json")), 5000, "R1 checkpoint");
    const r1cp = cp("r-a");
    actors = [leafCp.pid, r1cp.pid];

    // Joint loss, ordered as in the baseline: A reaps B, the harness SIGKILLs
    // its directly owned A. The gate for R1 is never opened.
    writeFileSync(join(dir, "kill-helper"), "1\n");
    await waitFor(() => existsSync(join(dir, "helper-killed.json")), 5000, "helper kill handshake");
    const helperKilled = readFileSync(join(dir, "helper-killed.json"), "utf8").match(/pid=(\d+) signal=(\d+) errno=(\d+)/);
    expect(helperKilled?.[1], "helper-killed marker must name B").toBe(String(helperCp.pid));
    expect(helperKilled?.[2], "B must die by SIGKILL").toBe("9");
    app!.kill(9);
    await app!.exited;
    expect(app!.signalCode).toBe("SIGKILL");

    // Survival proof before any recovery: C alive, orphaned to launchd.
    expect(leafIsAlive(leafCp.pid), "C must still be running before recovery").toBe(true);
    const leafOrphan = psInfo(leafCp.pid, ["ppid"]);
    expect(leafOrphan.status, leafOrphan.stderr).toBe(0);
    expect(Number(leafOrphan.stdout.trim()), "survivor must be reparented to launchd").toBe(1);

    // R1 confirms owner loss itself, then parks pre-cleanup on gate-a, which
    // the harness never creates: R1 structurally cannot reach cleanup code.
    await waitFor(() => existsSync(join(dir, "owner-loss-a")), 20_000, "R1 gate-park marker");
    expect(existsSync(join(dir, "receipt-a.json")), "parked R1 must have written no receipt").toBe(false);
    expect(leafIsAlive(r1cp.pid), "R1 must still be parked when removed").toBe(true);

    // Crash R1 through launchd's owned service, never through a saved PID.
    const kill1 = launchctl(["kill", "SIGKILL", jobs.r1.service]);
    expect(kill1.status, `R1 SIGKILL: ${kill1.stderr || kill1.error?.message}`).toBe(0);
    await waitFor(() => actorsAreAbsent([r1cp.pid]), 5000, "R1 process absence after SIGKILL");
    const killedJob = launchctl(["print", jobs.r1.service]);
    expect(killedJob.status, killedJob.stderr || killedJob.error?.message).toBe(0);
    expect(killedJob.stdout).toMatch(/last terminating signal = (?:[^\n]*: )?9\b/);
    const bootout1 = launchctl(["bootout", jobs.r1.service]);
    const scan1 = launchctl(["print", jobs.r1.service]);
    expect(bootout1.status, `R1 bootout: ${bootout1.stderr || bootout1.error?.message}`).toBe(0);
    expect(scan1.status, "R1 service must be absent after bootout").toBe(113);
    r1EarlyRemoved = true;
    expect(actorsAreAbsent([r1cp.pid]), "R1 must remain absent after bootout").toBe(true);
    expect(existsSync(join(dir, "receipt-a.json")), "killed R1 must never have written a receipt").toBe(false);
    expect(leafIsAlive(leafCp.pid), "C must survive R1's own removal").toBe(true);

    // A/B are independently absent (existence-only ps) before R2 starts.
    await waitFor(() => actorsAreAbsent([appCp.pid, helperCp.pid]), 5000, "A/B absence before R2");

    // Fresh R2, generation "b": a new UUID job with no channel to R1 — its only
    // inputs are the persisted pre-loss checkpoint files and its own gate.
    writeFileSync(jobs.r2.plist, supervisorPlist(jobs.r2.label, supervisorBin, dir, jobs.r2.gen));
    const bootstrap2 = launchctl(["bootstrap", domain, jobs.r2.plist]);
    registered.r2 = true;
    expect(bootstrap2.status, bootstrap2.stderr || bootstrap2.error?.message).toBe(0);
    bootstrapped.r2 = true;
    await waitFor(() => existsSync(join(dir, "r-b.json")), 5000, "R2 checkpoint");
    const r2cp = cp("r-b");
    actors = [leafCp.pid, r1cp.pid, r2cp.pid];
    expect(r2cp.pid !== r1cp.pid, "R2 must be a distinct process, not a revived R1").toBe(true);

    // R2 reconstructs all identities from the checkpoint files and confirms
    // owner loss (stale A/B tokens report ESRCH) before parking on gate-b.
    await waitFor(() => existsSync(join(dir, "owner-loss-b")), 20_000, "R2 gate-park marker");

    // Arm R2; it must clean C before C's independent alarm watchdog.
    const receiptBPath = join(dir, "receipt-b.json");
    const tGate = Date.now();
    writeFileSync(join(dir, "gate-b"), "1\n");
    await waitFor(() => existsSync(receiptBPath), 10_000, "R2 recovery receipt");
    const tReceipt = Date.now();
    const receipt = parseReceipt(receiptBPath);
    expect(receipt.status, `R2 receipt: ${JSON.stringify(receipt)}`).toBe("ok");
    expect(receipt.stage).toBe("recovery");
    expect(Number(receipt.leaf_pid), "R2 must target the identity rebuilt from leaf.json").toBe(leafCp.pid);
    expect(Number(receipt.owner_probe), "A's stale token must report ESRCH to R2").toBe(3);
    expect(Number(receipt.helper_probe), "B's stale token must report ESRCH to R2").toBe(3);
    expect(Number(receipt.alive_before_kill), "R2 must observe the authentic C generation alive").toBe(1);
    expect(Number(receipt.kill_return), "exact-generation SIGKILL must succeed").toBe(0);
    expect(Number(receipt.gone), "R2 must confirm C gone via exact-token probe").toBe(1);
    expect(tReceipt - tGate, `R2 recovery took ${tReceipt - tGate}ms after gate`).toBeLessThanOrEqual(10_500);
    expect(Number(receipt.recovered_at), "R2's receipt must precede C's watchdog").toBeLessThan(leafCp.deadline);
    expect(leafCp.deadline - Number(receipt.recovered_at), "R2 recovery must beat the independent watchdog with margin").toBeGreaterThan(5);

    // Independent existence confirmation before the watchdog and before finally.
    await waitFor(() => actorsAreAbsent([leafCp.pid]), 5000, "leaf absence after R2 recovery");
    expect(leafCp.deadline - Date.now() / 1000, "independent absence must also precede the watchdog with margin").toBeGreaterThan(5);
    ok = true;
    console.log(`restart_recovered=1 leaf_pid=${leafCp.pid} r1_pid=${r1cp.pid} r2_pid=${r2cp.pid} r1_removed=pre_cleanup_SIGKILL recovered_at=${receipt.recovered_at} leaf_backstop=${leafCp.deadline} gate_to_receipt_ms=${tReceipt - tGate} r1_label=${jobs.r1.label} r2_label=${jobs.r2.label}`);
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) {
      app.kill(9);
      await app.exited;
    }
    let cleaned = true;
    for (const id of ["r1", "r2"] as const) {
      if (!registered[id]) continue;
      const earlyRemoved = id === "r1" && r1EarlyRemoved;
      let bootoutStatus: number | null = null;
      if (!earlyRemoved) {
        const bootout = launchctl(["bootout", jobs[id].service]);
        bootoutStatus = bootout.status;
        if (bootoutStatus !== 0) console.error(`RESIDUAL_JOB=${jobs[id].service} bootout=${bootout.status} ${bootout.stderr}`);
      }
      const scan = launchctl(["print", jobs[id].service]);
      // Ambiguous registration or a possibly surviving service retains the owned dir.
      const serviceClean = !scan.error && scan.status === 113 &&
        (earlyRemoved ? bootstrapped.r1 : bootstrapped[id] && bootoutStatus === 0);
      console.log(`cleanup_service=${jobs[id].service} early_removed=${earlyRemoved} bootout=${bootoutStatus ?? "skipped"} print=${scan.status}`);
      if (!serviceClean) cleaned = false;
    }
    const processScan = actors.length ? psOf(actors) : null;
    const procsClean = !!processScan && !processScan.error && !processScan.signal && processScan.status === 1 &&
      processScan.stdout.trim() === "" && processScan.stderr.trim() === "";
    console.log(`cleanup_actor_ps=${processScan?.status ?? "not-recorded"} actor_pids=${actors.join(",")}`);
    if (!procsClean) cleaned = false;
    if (cleaned && ok) rmSync(dir, { recursive: true, force: true });
    else console.error(`RETAINED_RUN_DIR=${dir} cleaned=${cleaned} ok=${ok}`);
    expect(cleaned, `launchd job still present or recorded actor observable; owned files retained ${dir}`).toBe(true);
  }
}, 150_000);
