// Opt-in offline macOS experiment (PI_OFFLINE_COALITION_PROBE=1) completing
// the recovery feasibility family with the bounded post-kill/pre-receipt
// restart case: the first recovery owner R1 is killed by the harness (through
// exact UUID launchctl job control only) in the window AFTER it has
// SIGKILLed the escaped descendant C, confirmed C gone via its exact audit
// token, and durably checkpointed that confirmed kill — but BEFORE it wrote
// its receipt. A fresh R2 (new UUID job, distinct generation, no memory or
// IPC channel to R1) then rebuilds A/B/C identity from the persisted pre-loss
// checkpoints, strictly validates R1's postkill checkpoint, confirms A/B and
// C exact-token ESRCH, and writes a distinct successful already-absent
// receipt recording that NO SIGKILL was attempted (this mode cannot signal
// SIGKILL at all).
//
// Claim boundary: this proves restart recovery only when the first owner
// crashed after its confirmed kill was durably checkpointed (process crash).
// It does not cover a crash in the kill-to-checkpoint window, power loss, or
// reboot, and it does not weaken the plain-generation contract (an R2 without
// a validated postkill checkpoint still rejects an already-dead target).
//
// The second test pins the fail-closed contract: missing, identity-mismatched
// (a real dead actor's authentic token substituted for the leaf's), and
// contradicted (valid leaf identity claiming a kill that never happened, with
// the leaf still alive) postkill checkpoints must each produce a failure
// receipt with kill_attempted=0 — never turn an arbitrary dead target into
// success. The negative fixtures use only safe, original, authentic published
// tokens; no future token is ever fabricated or signaled.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  actorsAreAbsent, checkpointToken, compileFixture, fileExists, leafIsAlive,
  launchctl, parseCp, parsePostkill, parseReceipt, psInfo, psOf, supervisorPlist, waitFor,
} from "./recovery-harness";

test.skipIf(process.platform !== "darwin" || process.env.PI_OFFLINE_COALITION_PROBE !== "1")("post-kill/pre-receipt: R2 completes already-absent recovery from R1's validated postkill checkpoint", async () => {
  const domain = `gui/${process.getuid!()}`;
  const access = launchctl(["print", domain]);
  if (access.status !== 0) throw new Error(`No user-domain launchd access: ${access.stderr}`);
  const dir = mkdtempSync(join(tmpdir(), "pi-recovery-postkill-"));
  const mkJob = (gen: string, modeArgs: string[]) => {
    const label = `org.pix.offline-recovery-probe.${randomUUID()}`;
    return { gen, modeArgs, label, service: `${domain}/${label}`, plist: join(dir, `job-${gen}.plist`) };
  };
  // R1 kills C and parks pre-receipt; R2 rebuilds from R1's durable record.
  const jobs = { r1: mkJob("k1", ["kill-then-park"]), r2: mkJob("k2", ["already-absent", "k1"]) };
  const cp = (role: string) => parseCp(join(dir, `${role}.json`));
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
    const actorsCompile = compileFixture("recovery-actors.c", actorsBin);
    expect(actorsCompile.status, actorsCompile.stderr || actorsCompile.error?.message).toBe(0);
    const supervisorCompile = compileFixture("recovery-supervisor.c", supervisorBin);
    expect(supervisorCompile.status, supervisorCompile.stderr || supervisorCompile.error?.message).toBe(0);

    app = Bun.spawn([actorsBin, "app", dir], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    await waitFor(() => fileExists(join(dir, "app.json")) && fileExists(join(dir, "helper.json")) && fileExists(join(dir, "leaf.json")), 8000, "actor checkpoints");
    const appCp = cp("app");
    const helperCp = cp("helper");
    const leafCp = cp("leaf");
    const leafToken = checkpointToken(join(dir, "leaf.json"));

    // Escape proof before any owner dies: C leads its own process group.
    const leafPre = psInfo(leafCp.pid, ["pgid"]);
    expect(leafPre.status, leafPre.stderr).toBe(0);
    const leafPgid = Number(leafPre.stdout.trim());
    const appPre = psInfo(appCp.pid, ["pgid"]);
    expect(appPre.status, appPre.stderr || appPre.error?.message).toBe(0);
    const appPgid = Number(appPre.stdout.trim());
    expect(appPgid).toBeGreaterThan(0);
    expect(leafPgid, `leaf pgid ${leafPgid} must be its own pid (setsid+exec escaped)`).toBe(leafCp.pid);
    expect(leafPgid === appPgid, `leaf pgid ${leafPgid} must differ from app pgid ${appPgid}`).toBe(false);

    // R1: kill-then-park mode. It parks pre-kill on gate-k1 after owner loss.
    writeFileSync(jobs.r1.plist, supervisorPlist(jobs.r1.label, supervisorBin, dir, jobs.r1.gen, jobs.r1.modeArgs));
    const bootstrap1 = launchctl(["bootstrap", domain, jobs.r1.plist]);
    registered.r1 = true;
    expect(bootstrap1.status, bootstrap1.stderr || bootstrap1.error?.message).toBe(0);
    bootstrapped.r1 = true;
    await waitFor(() => fileExists(join(dir, "r-k1.json")), 5000, "R1 checkpoint");
    const r1cp = cp("r-k1");
    actors = [leafCp.pid, r1cp.pid];

    // Ordered joint loss, as in the baseline: A reaps B, the harness SIGKILLs
    // its directly owned A.
    writeFileSync(join(dir, "kill-helper"), "1\n");
    await waitFor(() => fileExists(join(dir, "helper-killed.json")), 5000, "helper kill handshake");
    const helperKilled = readFileSync(join(dir, "helper-killed.json"), "utf8").match(/pid=(\d+) signal=(\d+) errno=(\d+)/);
    expect(helperKilled?.[1], "helper-killed marker must name B").toBe(String(helperCp.pid));
    expect(helperKilled?.[2], "B must die by SIGKILL").toBe("9");
    app!.kill(9);
    await app!.exited;
    expect(app!.signalCode).toBe("SIGKILL");

    // Survival proof before the kill: C alive, orphaned to launchd.
    expect(leafIsAlive(leafCp.pid), "C must still be running before R1's kill").toBe(true);
    const leafOrphan = psInfo(leafCp.pid, ["ppid"]);
    expect(leafOrphan.status, leafOrphan.stderr).toBe(0);
    expect(Number(leafOrphan.stdout.trim()), "survivor must be reparented to launchd").toBe(1);

    // R1 confirmed owner loss itself and is parked pre-kill; arm the kill.
    await waitFor(() => fileExists(join(dir, "owner-loss-k1")), 20_000, "R1 gate-park marker");
    expect(leafIsAlive(r1cp.pid), "R1 must be parked when armed").toBe(true);
    writeFileSync(join(dir, "gate-k1"), "1\n");

    // R1 performs the actual exact-token SIGKILL, confirms ESRCH, and writes
    // the durable postkill checkpoint before any receipt.
    await waitFor(() => fileExists(join(dir, "postkill-k1.json")), 10_000, "postkill checkpoint");
    const pk = parsePostkill(join(dir, "postkill-k1.json"));
    expect(pk.gen, "postkill checkpoint must name its generation").toBe("k1");
    expect(pk.pid, "postkill checkpoint must name the exact leaf PID").toBe(leafCp.pid);
    expect(pk.pidversion, "postkill checkpoint must name the exact leaf PID-version").toBe(leafCp.pidversion);
    expect(pk.token, "postkill checkpoint must carry the leaf's authentic token").toBe(leafToken);
    expect(pk.killReturn, "recorded kill must have succeeded").toBe(0);
    expect(pk.gone, "recorded kill must be confirmed gone (ESRCH)").toBe(1);
    expect(pk.leafDeadline).toBe(leafCp.deadline);
    expect(pk.killedAt, "recorded kill must precede C's watchdog").toBeLessThan(leafCp.deadline);

    // Pre-receipt park: no receipt may exist while R1 waits on receipt-gate-k1.
    expect(existsSync(join(dir, "receipt-k1.json")), "parked R1 must have written no receipt").toBe(false);
    expect(leafIsAlive(r1cp.pid), "R1 must still be parked pre-receipt").toBe(true);

    // Harness independently observes C absent, with watchdog margin, BEFORE
    // removing R1.
    await waitFor(() => actorsAreAbsent([leafCp.pid]), 5000, "leaf absence after R1's kill");
    expect(leafCp.deadline - Date.now() / 1000, "harness C-absence must precede the watchdog with margin").toBeGreaterThan(5);
    expect(existsSync(join(dir, "receipt-k1.json")), "R1 must still be pre-receipt").toBe(false);

    // Kill R1 through its exact UUID service only, requiring signal 9 and
    // process absence before bootout/print-113.
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
    expect(existsSync(join(dir, "receipt-k1.json")), "killed R1 must never have written a receipt").toBe(false);
    expect(actorsAreAbsent([leafCp.pid]), "C must remain absent after R1's removal").toBe(true);

    // A/B independently absent before R2 starts.
    await waitFor(() => actorsAreAbsent([appCp.pid, helperCp.pid]), 5000, "A/B absence before R2");

    // Fresh R2: new UUID job, generation k2, already-absent mode validated
    // against R1's k1 postkill checkpoint. Its only inputs are files.
    writeFileSync(jobs.r2.plist, supervisorPlist(jobs.r2.label, supervisorBin, dir, jobs.r2.gen, jobs.r2.modeArgs));
    const bootstrap2 = launchctl(["bootstrap", domain, jobs.r2.plist]);
    registered.r2 = true;
    expect(bootstrap2.status, bootstrap2.stderr || bootstrap2.error?.message).toBe(0);
    bootstrapped.r2 = true;
    await waitFor(() => fileExists(join(dir, "r-k2.json")), 5000, "R2 checkpoint");
    const r2cp = cp("r-k2");
    actors = [leafCp.pid, r1cp.pid, r2cp.pid];
    expect(r2cp.pid !== r1cp.pid, "R2 must be a distinct process, not a revived R1").toBe(true);
    await waitFor(() => fileExists(join(dir, "owner-loss-k2")), 20_000, "R2 gate-park marker");

    // Arm R2's validation-and-receipt stage.
    const tGate = Date.now();
    writeFileSync(join(dir, "gate-k2"), "1\n");
    await waitFor(() => fileExists(join(dir, "receipt-k2.json")), 10_000, "R2 already-absent receipt");
    const tReceipt = Date.now();
    const receipt = parseReceipt(join(dir, "receipt-k2.json"));
    expect(receipt.status, `R2 receipt: ${JSON.stringify(receipt)}`).toBe("ok");
    expect(receipt.stage, "R2 must record the distinct already-absent stage").toBe("already-absent");
    expect(receipt.reason).toBe("confirmed");
    expect(Number(receipt.leaf_pid), "R2 must target the identity rebuilt from leaf.json").toBe(leafCp.pid);
    expect(Number(receipt.owner_probe), "A's stale token must report ESRCH to R2").toBe(3);
    expect(Number(receipt.helper_probe), "B's stale token must report ESRCH to R2").toBe(3);
    expect(Number(receipt.absent_probe), "R2 must confirm C's exact token ESRCH itself").toBe(3);
    expect(Number(receipt.kill_attempted), "R2 must record that it attempted no SIGKILL").toBe(0);
    expect(Number(receipt.kill_return), "kill_return must carry the NOT_ATTEMPTED sentinel").toBe(-2);
    expect(receipt.postkill_gen, "receipt must name the validated postkill generation").toBe("k1");
    expect(Number(receipt.recovered_at), "R2's receipt must precede C's watchdog").toBeLessThan(leafCp.deadline);
    expect(leafCp.deadline - Number(receipt.recovered_at), "R2 conclusion must beat the watchdog with margin").toBeGreaterThan(5);
    expect(tReceipt - tGate, `R2 took ${tReceipt - tGate}ms after gate`).toBeLessThanOrEqual(10_500);

    // Independent existence confirmation before `finally` and the watchdog.
    expect(actorsAreAbsent([leafCp.pid]), "C must be independently absent before finally").toBe(true);
    expect(leafCp.deadline - Date.now() / 1000, "independent absence must precede the watchdog with margin").toBeGreaterThan(5);
    ok = true;
    console.log(`postkill_restart_recovered=1 leaf_pid=${leafCp.pid} r1_pid=${r1cp.pid} r2_pid=${r2cp.pid} r1_removed=postkill_prereceipt_SIGKILL killed_at=${pk.killedAt} recovered_at=${receipt.recovered_at} leaf_backstop=${leafCp.deadline} gate_to_receipt_ms=${tReceipt - tGate} r1_label=${jobs.r1.label} r2_label=${jobs.r2.label}`);
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

test.skipIf(process.platform !== "darwin" || process.env.PI_OFFLINE_COALITION_PROBE !== "1")("already-absent R2 fails closed on missing, mismatched, and contradicted postkill checkpoints", async () => {
  const domain = `gui/${process.getuid!()}`;
  const access = launchctl(["print", domain]);
  if (access.status !== 0) throw new Error(`No user-domain launchd access: ${access.stderr}`);
  const dir = mkdtempSync(join(tmpdir(), "pi-recovery-postkill-neg-"));
  const cp = (role: string) => parseCp(join(dir, `${role}.json`));
  // Build a postkill checkpoint line from an actor's own published identity.
  // Only authentic original tokens are ever used; none is ever signaled —
  // the already-absent mode cannot send SIGKILL, and the assertions below
  // require C to still be alive after every case.
  const postkillLineFrom = (rolePath: string, gen: string, leafDeadline: number) => {
    const m = readFileSync(rolePath, "utf8").match(/pid=(\d+) pidversion=(\d+) token=([0-9a-f]{64})/);
    if (!m) throw new Error(`no identity in ${rolePath}`);
    return `role=postkill gen=${gen} pid=${m[1]} pidversion=${m[2]} token=${m[3]} killed_at=${Math.floor(Date.now() / 1000)} leaf_deadline=${leafDeadline} kill_return=0 kill_errno=0 gone=1 gone_errno=3\n`;
  };
  type Case = { gen: string; killGen: string; stage: string; reason: string; absentProbe?: number };
  const cases: Case[] = [
    // No postkill-x0.json is ever created: the record is simply missing.
    { gen: "x1", killGen: "x0", stage: "postkill-checkpoint", reason: "missing" },
    // postkill-x2.json carries B's authentic (really dead) identity in place
    // of the leaf's: internally consistent, but cross-validation must fail.
    { gen: "x2", killGen: "x2", stage: "postkill-checkpoint", reason: "token-mismatch" },
    // postkill-x3.json carries the leaf's own authentic identity but claims a
    // confirmed kill that never happened; the still-alive leaf contradicts it.
    { gen: "x3", killGen: "x3", stage: "target-alive", reason: "not-absent", absentProbe: 0 },
    { gen: "x4", killGen: "x4", stage: "postkill-checkpoint", reason: "unparseable" },
    { gen: "x5", killGen: "x5", stage: "postkill-checkpoint", reason: "unparseable" },
    { gen: "x6", killGen: "x6", stage: "postkill-checkpoint", reason: "bad-result" },
    { gen: "x7", killGen: "x7", stage: "postkill-checkpoint", reason: "bad-result" },
    { gen: "x8", killGen: "x8", stage: "postkill-checkpoint", reason: "gen-mismatch" },
  ];
  const mkJob = (c: Case) => {
    const label = `org.pix.offline-recovery-probe.${randomUUID()}`;
    return { ...c, label, service: `${domain}/${label}`, plist: join(dir, `job-${c.gen}.plist`) };
  };
  const jobs = cases.map(mkJob);
  const registered = jobs.map(() => false);
  // Set only after the in-case bootout returned 0 AND the exact service lookup reported absence.
  const earlyRemoved = jobs.map(() => false);
  let actors: number[] = [];
  let app: ReturnType<typeof Bun.spawn> | null = null;
  let ok = false;
  try {
    const actorsBin = join(dir, "actors");
    const supervisorBin = join(dir, "supervisor");
    const actorsCompile = compileFixture("recovery-actors.c", actorsBin);
    expect(actorsCompile.status, actorsCompile.stderr || actorsCompile.error?.message).toBe(0);
    const supervisorCompile = compileFixture("recovery-supervisor.c", supervisorBin);
    expect(supervisorCompile.status, supervisorCompile.stderr || supervisorCompile.error?.message).toBe(0);

    app = Bun.spawn([actorsBin, "app", dir], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    await waitFor(() => fileExists(join(dir, "app.json")) && fileExists(join(dir, "helper.json")) && fileExists(join(dir, "leaf.json")), 8000, "actor checkpoints");
    const appCp = cp("app");
    const helperCp = cp("helper");
    const leafCp = cp("leaf");

    // The deliberately wrong evidence records, built from authentic identities.
    writeFileSync(join(dir, "postkill-x2.json"), postkillLineFrom(join(dir, "helper.json"), "x2", leafCp.deadline));
    writeFileSync(join(dir, "postkill-x3.json"), postkillLineFrom(join(dir, "leaf.json"), "x3", leafCp.deadline));
    const leafRecord = (gen: string) => postkillLineFrom(join(dir, "leaf.json"), gen, leafCp.deadline);
    writeFileSync(join(dir, "postkill-x4.json"), leafRecord("x4").trimEnd() + " trailing=garbage\n");
    writeFileSync(join(dir, "postkill-x5.json"), leafRecord("x5") + "gone=0\n");
    writeFileSync(join(dir, "postkill-x6.json"), leafRecord("x6").replace("kill_errno=0", "kill_errno=1"));
    writeFileSync(join(dir, "postkill-x7.json"), leafRecord("x7").replace("gone_errno=3", "gone_errno=0"));
    writeFileSync(join(dir, "postkill-x8.json"), leafRecord("wrong"));

    // Ordered joint loss; C is never killed in this test and must survive
    // every case, dying only by its own watchdog at the end.
    writeFileSync(join(dir, "kill-helper"), "1\n");
    await waitFor(() => fileExists(join(dir, "helper-killed.json")), 5000, "helper kill handshake");
    const helperKilled = readFileSync(join(dir, "helper-killed.json"), "utf8").match(/pid=(\d+) signal=(\d+) errno=(\d+)/);
    expect(helperKilled?.[1], "helper-killed marker must name B").toBe(String(helperCp.pid));
    expect(helperKilled?.[2], "B must die by SIGKILL").toBe("9");
    app!.kill(9);
    await app!.exited;
    expect(app!.signalCode).toBe("SIGKILL");
    expect(leafIsAlive(leafCp.pid), "C must still be alive before the cases").toBe(true);
    const leafOrphan = psInfo(leafCp.pid, ["ppid"]);
    expect(leafOrphan.status, leafOrphan.stderr).toBe(0);
    expect(Number(leafOrphan.stdout.trim()), "survivor must be reparented to launchd").toBe(1);
    actors = [appCp.pid, helperCp.pid, leafCp.pid];

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      writeFileSync(job.plist, supervisorPlist(job.label, supervisorBin, dir, job.gen, ["already-absent", job.killGen]));
      const bootstrap = launchctl(["bootstrap", domain, job.plist]);
      registered[i] = true;
      expect(bootstrap.status, `${job.gen} bootstrap: ${bootstrap.stderr || bootstrap.error?.message}`).toBe(0);
      await waitFor(() => fileExists(join(dir, `r-${job.gen}.json`)), 5000, `${job.gen} supervisor checkpoint`);
      const rcp = cp(`r-${job.gen}`);
      actors = [...actors, rcp.pid];
      await waitFor(() => fileExists(join(dir, `owner-loss-${job.gen}`)), 20_000, `${job.gen} gate-park marker`);
      writeFileSync(join(dir, `gate-${job.gen}`), "1\n");
      const receiptPath = join(dir, `receipt-${job.gen}.json`);
      await waitFor(() => fileExists(receiptPath), 10_000, `${job.gen} receipt`);
      const receipt = parseReceipt(receiptPath);
      expect(receipt.status, `${job.gen} must fail closed: ${JSON.stringify(receipt)}`).toBe("fail");
      expect(receipt.stage, `${job.gen} failure stage`).toBe(job.stage);
      expect(receipt.reason, `${job.gen} failure reason`).toBe(job.reason);
      expect(Number(receipt.kill_attempted), `${job.gen} must record kill_attempted=0`).toBe(0);
      expect(Number(receipt.kill_return), `${job.gen} must carry the NOT_ATTEMPTED sentinel`).toBe(-2);
      if (job.absentProbe !== undefined) {
        expect(Number(receipt.absent_probe), `${job.gen} absent probe must show the live leaf`).toBe(job.absentProbe);
      }
      expect(Number(receipt.owner_probe), `${job.gen} must still confirm A ESRCH`).toBe(3);
      expect(Number(receipt.helper_probe), `${job.gen} must still confirm B ESRCH`).toBe(3);
      // The fail-closed path never killed anything: C is still alive.
      expect(leafIsAlive(leafCp.pid), `${job.gen} must leave the live leaf untouched`).toBe(true);
      const bootout = launchctl(["bootout", job.service]);
      expect(bootout.status, `${job.gen} bootout: ${bootout.stderr || bootout.error?.message}`).toBe(0);
      expect(launchctl(["print", job.service]).status, `${job.gen} service must be absent`).toBe(113);
      earlyRemoved[i] = true;
      expect(actorsAreAbsent([rcp.pid]), `${job.gen} supervisor must be gone`).toBe(true);
      console.log(`failclosed_case=${job.gen} stage=${job.stage} reason=${job.reason} leaf_alive=1 supervisor_pid=${rcp.pid}`);
    }

    // C dies only by its own independent watchdog, never by any R2 case.
    const watchdogMs = Math.max(0, leafCp.deadline * 1000 - Date.now()) + 8000;
    await waitFor(() => actorsAreAbsent([leafCp.pid]), watchdogMs, "leaf watchdog death after fail-closed cases");
    ok = true;
    console.log(`failclosed_total=${cases.length} leaf_pid=${leafCp.pid} leaf_backstop=${leafCp.deadline}`);
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) {
      app.kill(9);
      await app.exited;
    }
    let cleaned = true;
    for (let i = 0; i < jobs.length; i++) {
      if (!registered[i]) continue;
      let bootoutStatus: number | null = null;
      if (!earlyRemoved[i]) {
        const bootout = launchctl(["bootout", jobs[i].service]);
        bootoutStatus = bootout.status;
        if (bootoutStatus !== 0) console.error(`RESIDUAL_JOB=${jobs[i].service} bootout=${bootout.status} ${bootout.stderr}`);
      }
      const scan = launchctl(["print", jobs[i].service]);
      const serviceClean = !scan.error && scan.status === 113 &&
        (earlyRemoved[i] || bootoutStatus === 0);
      console.log(`cleanup_service=${jobs[i].service} early_removed=${earlyRemoved[i]} bootout=${bootoutStatus ?? "skipped"} print=${scan.status}`);
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
}, 120_000);
