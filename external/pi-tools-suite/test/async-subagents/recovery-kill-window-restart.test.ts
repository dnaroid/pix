// Opt-in offline macOS experiment (PI_OFFLINE_COALITION_PROBE=1) covering
// the kill-to-checkpoint window that the post-kill/pre-receipt experiment
// explicitly excluded: the first recovery owner R1 is killed by the harness
// (through exact UUID launchctl job control only) AFTER it has SIGKILLed the
// escaped descendant C and confirmed C gone via its exact audit token, but
// BEFORE it published its postkill checkpoint — so no durable kill record
// exists at all. A fresh R2 (new UUID job, distinct generation, no memory or
// IPC channel to R1, consuming none of R1's markers) rebuilds A/B/C identity
// from the persisted pre-loss actor records, confirms A/B exact-token ESRCH,
// observes its OWN exact-token absence of C, and writes a distinct
// already-absent receipt with reason=cause-unknown and postkill_record=absent
// recording that NO SIGKILL was attempted (kill_attempted=0, kill_return=-2).
// The unknown path is only reachable through a genuinely ENOENT-missing
// record; it can never report kill success or attribute C's death.
//
// The second test pins the fail-closed contract of the new mode with a LIVE
// leaf: an ENOENT record with the target still alive fails
// target-alive/not-absent without any SIGKILL, both when no record exists at
// all and when a well-formed record exists under a different generation (no
// generation inference or sibling-record scanning). The positive test adds
// the present-invalid-and-dead case: a corrupt postkill record built from
// the dead leaf's own authentic identity must fail closed with the strict
// loader reason even though C is observably gone — a present record never
// falls back to the cause-unknown path. The same positive test also pins a
// DANGLING postkill-<gen>.json symlink (already-dead C): a symlink whose
// target does not exist is a present nonregular entry, so it must fail
// closed with reason=not-regular instead of sliding into the ENOENT
// cause-unknown path that a following access(F_OK) probe would have taken.
// Legacy modes (including the strict already-absent missing-record failure)
// are untouched and pinned by recovery-postkill-restart.test.ts.
//
// Claim boundary: this proves bounded process-crash recovery inside the
// kill-to-checkpoint window, where absence is re-proven by R2's own probe and
// the receipt claims cause-unknown. It does not prove kill attribution, power
// loss, or reboot durability. No fabricated orphan tokens are ever signaled;
// only authentic published identities appear in crafted records.
import { test, expect } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  actorsAreAbsent, compileFixture, fileExists, leafIsAlive,
  launchctl, parseCp, parseReceipt, psInfo, psOf, supervisorPlist, waitFor,
} from "./recovery-harness";

test.skipIf(process.platform !== "darwin" || process.env.PI_OFFLINE_COALITION_PROBE !== "1")("kill-to-checkpoint window: R2 already-absent-unknown reports cause-unknown from its own probe; present invalid and dangling-symlink records fail closed even with C dead", async () => {
  const domain = `gui/${process.getuid!()}`;
  const access = launchctl(["print", domain]);
  if (access.status !== 0) throw new Error(`No user-domain launchd access: ${access.stderr}`);
  const dir = mkdtempSync(join(tmpdir(), "pi-recovery-kill-window-"));
  const mkJob = (gen: string, modeArgs: string[]) => {
    const label = `org.pix.offline-recovery-probe.${randomUUID()}`;
    return { gen, modeArgs, label, service: `${domain}/${label}`, plist: join(dir, `job-${gen}.plist`) };
  };
  // R1 kills C and parks pre-checkpoint; R2 concludes cause-unknown absence
  // from the genuinely missing w1 record; R3 must reject a present-but-invalid
  // record although C is already dead; R4 must reject a present-but-nonregular
  // record (a dangling postkill-w4.json symlink) the same way.
  const jobs = { r1: mkJob("w1", ["kill-park-precheck"]), r2: mkJob("w2", ["already-absent-unknown", "w1"]), r3: mkJob("w3", ["already-absent-unknown", "w3"]), r4: mkJob("w4", ["already-absent-unknown", "w4"]) };
  const cp = (role: string) => parseCp(join(dir, `${role}.json`));
  const registered = { r1: false, r2: false, r3: false, r4: false };
  // Set only after a job's mid-test bootout returned 0 AND the exact service
  // lookup reported absence.
  const earlyRemoved = { r1: false, r2: false, r3: false, r4: false };
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

    // R1: kill-park-precheck mode. It parks pre-kill on gate-w1 after owner
    // loss, then (after the real exact-token SIGKILL and its ESRCH
    // confirmation) parks again on checkpoint-gate-w1 BEFORE any postkill
    // record or receipt exists.
    writeFileSync(jobs.r1.plist, supervisorPlist(jobs.r1.label, supervisorBin, dir, jobs.r1.gen, jobs.r1.modeArgs));
    const bootstrap1 = launchctl(["bootstrap", domain, jobs.r1.plist]);
    registered.r1 = true;
    expect(bootstrap1.status, bootstrap1.stderr || bootstrap1.error?.message).toBe(0);
    await waitFor(() => fileExists(join(dir, "r-w1.json")), 5000, "R1 checkpoint");
    const r1cp = cp("r-w1");
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
    await waitFor(() => fileExists(join(dir, "owner-loss-w1")), 20_000, "R1 gate-park marker");
    expect(leafIsAlive(r1cp.pid), "R1 must be parked when armed").toBe(true);
    writeFileSync(join(dir, "gate-w1"), "1\n");

    // R1 performed the real exact-token SIGKILL and confirmed ESRCH; it is
    // now parked inside the kill-to-checkpoint window: the precheck marker
    // exists, but neither a kill record nor a receipt was published.
    await waitFor(() => fileExists(join(dir, "precheck-w1")), 10_000, "precheckpoint park marker");
    expect(existsSync(join(dir, "postkill-w1.json")), "parked R1 must have written no postkill record").toBe(false);
    expect(existsSync(join(dir, "receipt-w1.json")), "parked R1 must have written no receipt").toBe(false);
    expect(leafIsAlive(r1cp.pid), "R1 must still be parked pre-checkpoint").toBe(true);

    // Harness independently observes C absent, with watchdog margin, BEFORE
    // removing R1.
    await waitFor(() => actorsAreAbsent([leafCp.pid]), 5000, "leaf absence after R1's kill");
    expect(leafCp.deadline - Date.now() / 1000, "harness C-absence must precede the watchdog with margin").toBeGreaterThan(5);
    expect(existsSync(join(dir, "postkill-w1.json")), "R1 must still be pre-checkpoint").toBe(false);

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
    earlyRemoved.r1 = true;
    expect(actorsAreAbsent([r1cp.pid]), "R1 must remain absent after bootout").toBe(true);
    // The kill-to-checkpoint crash: no durable kill record, no receipt, ever.
    expect(existsSync(join(dir, "postkill-w1.json")), "killed R1 must never have written a postkill record").toBe(false);
    expect(existsSync(join(dir, "receipt-w1.json")), "killed R1 must never have written a receipt").toBe(false);
    expect(actorsAreAbsent([leafCp.pid]), "C must remain absent after R1's removal").toBe(true);

    // A/B independently absent before R2 starts.
    await waitFor(() => actorsAreAbsent([appCp.pid, helperCp.pid]), 5000, "A/B absence before R2");

    // Fresh R2: new UUID job, generation w2, already-absent-unknown against
    // the genuinely missing w1 record. Its only inputs are the original actor
    // checkpoint files; it consumes no R1 memory, IPC, marker, or receipt.
    writeFileSync(jobs.r2.plist, supervisorPlist(jobs.r2.label, supervisorBin, dir, jobs.r2.gen, jobs.r2.modeArgs));
    const bootstrap2 = launchctl(["bootstrap", domain, jobs.r2.plist]);
    registered.r2 = true;
    expect(bootstrap2.status, bootstrap2.stderr || bootstrap2.error?.message).toBe(0);
    await waitFor(() => fileExists(join(dir, "r-w2.json")), 5000, "R2 checkpoint");
    const r2cp = cp("r-w2");
    actors = [leafCp.pid, r1cp.pid, r2cp.pid];
    expect(r2cp.pid !== r1cp.pid, "R2 must be a distinct process, not a revived R1").toBe(true);
    await waitFor(() => fileExists(join(dir, "owner-loss-w2")), 20_000, "R2 gate-park marker");

    // Arm R2's ENOENT-branch validation-and-receipt stage.
    const tGate = Date.now();
    writeFileSync(join(dir, "gate-w2"), "1\n");
    await waitFor(() => fileExists(join(dir, "receipt-w2.json")), 10_000, "R2 already-absent-unknown receipt");
    const tReceipt = Date.now();
    const receipt = parseReceipt(join(dir, "receipt-w2.json"));
    expect(receipt.status, `R2 receipt: ${JSON.stringify(receipt)}`).toBe("ok");
    expect(receipt.stage, "R2 must record the distinct already-absent stage").toBe("already-absent");
    expect(receipt.reason, "R2 may only conclude cause-unknown, never kill success").toBe("cause-unknown");
    expect(receipt.postkill_record, "R2 must record that no postkill record exists").toBe("absent");
    expect(Number(receipt.leaf_pid), "R2 must target the identity rebuilt from leaf.json").toBe(leafCp.pid);
    expect(Number(receipt.owner_probe), "A's stale token must report ESRCH to R2").toBe(3);
    expect(Number(receipt.helper_probe), "B's stale token must report ESRCH to R2").toBe(3);
    expect(Number(receipt.absent_probe), "R2 must confirm C's exact token ESRCH itself").toBe(3);
    expect(Number(receipt.kill_attempted), "R2 must record that it attempted no SIGKILL").toBe(0);
    expect(Number(receipt.kill_return), "kill_return must carry the NOT_ATTEMPTED sentinel").toBe(-2);
    expect(receipt.postkill_gen, "receipt must name the consulted kill generation").toBe("w1");
    expect(Number(receipt.recovered_at), "R2's receipt must precede C's watchdog").toBeLessThan(leafCp.deadline);
    expect(leafCp.deadline - Number(receipt.recovered_at), "R2 conclusion must beat the watchdog with margin").toBeGreaterThan(5);
    expect(tReceipt - tGate, `R2 took ${tReceipt - tGate}ms after gate`).toBeLessThanOrEqual(10_500);
    // R2 never fabricated a durable record for its own conclusion.
    expect(existsSync(join(dir, "postkill-w2.json")), "R2 must not fabricate a postkill record").toBe(false);
    const bootout2 = launchctl(["bootout", jobs.r2.service]);
    expect(bootout2.status, `R2 bootout: ${bootout2.stderr || bootout2.error?.message}`).toBe(0);
    expect(launchctl(["print", jobs.r2.service]).status, "R2 service must be absent").toBe(113);
    earlyRemoved.r2 = true;
    expect(actorsAreAbsent([r2cp.pid]), "R2 supervisor must be gone").toBe(true);

    // Independent existence confirmation before `finally` and the watchdog.
    expect(actorsAreAbsent([leafCp.pid]), "C must be independently absent before finally").toBe(true);
    expect(leafCp.deadline - Date.now() / 1000, "independent absence must precede the watchdog with margin").toBeGreaterThan(5);

    // Present-but-invalid record with C actually dead: only genuine ENOENT
    // may take the cause-unknown path, so strict validation must fail closed
    // here even though an absence probe would have succeeded. The corrupt
    // record carries the dead leaf's own authentic identity.
    const leafIdentity = readFileSync(join(dir, "leaf.json"), "utf8").match(/pid=(\d+) pidversion=(\d+) token=([0-9a-f]{64})/);
    if (!leafIdentity) throw new Error("no identity in leaf.json");
    writeFileSync(join(dir, "postkill-w3.json"),
      `role=postkill gen=w3 pid=${leafIdentity[1]} pidversion=${leafIdentity[2]} token=${leafIdentity[3]} killed_at=${Math.floor(Date.now() / 1000)} leaf_deadline=${leafCp.deadline} kill_return=0 kill_errno=0 gone=1 gone_errno=3 trailing=garbage\n`);
    writeFileSync(jobs.r3.plist, supervisorPlist(jobs.r3.label, supervisorBin, dir, jobs.r3.gen, jobs.r3.modeArgs));
    const bootstrap3 = launchctl(["bootstrap", domain, jobs.r3.plist]);
    registered.r3 = true;
    expect(bootstrap3.status, bootstrap3.stderr || bootstrap3.error?.message).toBe(0);
    await waitFor(() => fileExists(join(dir, "r-w3.json")), 5000, "R3 checkpoint");
    const r3cp = cp("r-w3");
    actors = [leafCp.pid, r1cp.pid, r2cp.pid, r3cp.pid];
    await waitFor(() => fileExists(join(dir, "owner-loss-w3")), 20_000, "R3 gate-park marker");
    writeFileSync(join(dir, "gate-w3"), "1\n");
    await waitFor(() => fileExists(join(dir, "receipt-w3.json")), 10_000, "R3 fail-closed receipt");
    const receipt3 = parseReceipt(join(dir, "receipt-w3.json"));
    expect(receipt3.status, `R3 must fail closed despite C being dead: ${JSON.stringify(receipt3)}`).toBe("fail");
    expect(receipt3.stage, "R3 failure stage").toBe("postkill-checkpoint");
    expect(receipt3.reason, "R3 must report the strict loader reason, not fall back to unknown").toBe("unparseable");
    expect(receipt3.postkill_record, "R3 must record that a (invalid) record was present").toBe("present");
    expect(Number(receipt3.kill_attempted), "R3 must record kill_attempted=0").toBe(0);
    expect(Number(receipt3.kill_return), "R3 must carry the NOT_ATTEMPTED sentinel").toBe(-2);
    expect(actorsAreAbsent([leafCp.pid]), "C stays absent; the invalid record never became success").toBe(true);
    const bootout3 = launchctl(["bootout", jobs.r3.service]);
    expect(bootout3.status, `R3 bootout: ${bootout3.stderr || bootout3.error?.message}`).toBe(0);
    expect(launchctl(["print", jobs.r3.service]).status, "R3 service must be absent").toBe(113);
    earlyRemoved.r3 = true;
    expect(actorsAreAbsent([r3cp.pid]), "R3 supervisor must be gone").toBe(true);

    // Dangling-symlink record with C still dead: the postkill entry for w4 is
    // a symlink whose target does not exist. A following F_OK probe reports
    // ENOENT and would misclassify this present nonregular entry as missing
    // (opening the cause-unknown path); the supervisor must classify the
    // entry without following symlinks and fail closed as present.
    const danglingEntry = join(dir, "postkill-w4.json");
    symlinkSync(join(dir, "postkill-w4-target-never-created.json"), danglingEntry);
    expect(lstatSync(danglingEntry).isSymbolicLink(), "fixture must publish a present symlink entry").toBe(true);
    expect(existsSync(danglingEntry), "dangling symlink must not resolve; that is the misclassification trap").toBe(false);
    writeFileSync(jobs.r4.plist, supervisorPlist(jobs.r4.label, supervisorBin, dir, jobs.r4.gen, jobs.r4.modeArgs));
    const bootstrap4 = launchctl(["bootstrap", domain, jobs.r4.plist]);
    registered.r4 = true;
    expect(bootstrap4.status, `R4 bootstrap: ${bootstrap4.stderr || bootstrap4.error?.message}`).toBe(0);
    await waitFor(() => fileExists(join(dir, "r-w4.json")), 5000, "R4 checkpoint");
    const r4cp = cp("r-w4");
    actors = [leafCp.pid, r1cp.pid, r2cp.pid, r3cp.pid, r4cp.pid];
    await waitFor(() => fileExists(join(dir, "owner-loss-w4")), 20_000, "R4 gate-park marker");
    writeFileSync(join(dir, "gate-w4"), "1\n");
    await waitFor(() => fileExists(join(dir, "receipt-w4.json")), 10_000, "R4 fail-closed receipt");
    const receipt4 = parseReceipt(join(dir, "receipt-w4.json"));
    expect(receipt4.status, `R4 must fail closed on the dangling symlink despite C being dead: ${JSON.stringify(receipt4)}`).toBe("fail");
    expect(receipt4.stage, "R4 failure stage").toBe("postkill-checkpoint");
    expect(receipt4.reason, "R4 must reject the nonregular entry as present, never classify it as missing").toBe("not-regular");
    expect(receipt4.postkill_record, "R4 must record the dangling symlink as a present entry").toBe("present");
    expect(Number(receipt4.kill_attempted), "R4 must record kill_attempted=0").toBe(0);
    expect(Number(receipt4.kill_return), "R4 must carry the NOT_ATTEMPTED sentinel").toBe(-2);
    expect(Number(receipt4.leaf_pid), "R4 must still target the identity rebuilt from leaf.json").toBe(leafCp.pid);
    expect(actorsAreAbsent([leafCp.pid]), "C stays absent; the dangling record never became success or cause-unknown").toBe(true);
    const bootout4 = launchctl(["bootout", jobs.r4.service]);
    expect(bootout4.status, `R4 bootout: ${bootout4.stderr || bootout4.error?.message}`).toBe(0);
    expect(launchctl(["print", jobs.r4.service]).status, "R4 service must be absent").toBe(113);
    earlyRemoved.r4 = true;
    expect(actorsAreAbsent([r4cp.pid]), "R4 supervisor must be gone").toBe(true);
    ok = true;
    console.log(`kill_window_recovered=1 leaf_pid=${leafCp.pid} r1_pid=${r1cp.pid} r2_pid=${r2cp.pid} r1_removed=precheckpoint_SIGKILL postkill_record=absent reason=cause-unknown present_invalid_dead=fail-unparseable dangling_symlink_dead=fail-not-regular leaf_backstop=${leafCp.deadline} gate_to_receipt_ms=${tReceipt - tGate} r1_label=${jobs.r1.label} r2_label=${jobs.r2.label} r3_label=${jobs.r3.label} r4_label=${jobs.r4.label}`);
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) {
      app.kill(9);
      await app.exited;
    }
    let cleaned = true;
    for (const id of ["r1", "r2", "r3", "r4"] as const) {
      if (!registered[id]) continue;
      let bootoutStatus: number | null = null;
      if (!earlyRemoved[id]) {
        const bootout = launchctl(["bootout", jobs[id].service]);
        bootoutStatus = bootout.status;
        if (bootoutStatus !== 0) console.error(`RESIDUAL_JOB=${jobs[id].service} bootout=${bootout.status} ${bootout.stderr}`);
      }
      const scan = launchctl(["print", jobs[id].service]);
      const serviceClean = !scan.error && scan.status === 113 &&
        (earlyRemoved[id] || bootoutStatus === 0);
      console.log(`cleanup_service=${jobs[id].service} early_removed=${earlyRemoved[id]} bootout=${bootoutStatus ?? "skipped"} print=${scan.status}`);
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
}, 180_000);

test.skipIf(process.platform !== "darwin" || process.env.PI_OFFLINE_COALITION_PROBE !== "1")("already-absent-unknown fails closed on ENOENT with a live target (missing and wrong-generation records), without SIGKILL", async () => {
  const domain = `gui/${process.getuid!()}`;
  const access = launchctl(["print", domain]);
  if (access.status !== 0) throw new Error(`No user-domain launchd access: ${access.stderr}`);
  const dir = mkdtempSync(join(tmpdir(), "pi-recovery-kill-window-neg-"));
  const cp = (role: string) => parseCp(join(dir, `${role}.json`));
  type Case = { gen: string; killGen: string };
  // y1: no record at all for kill-gen y0. y2: a well-formed record exists
  // under a DIFFERENT generation (yr), proving no sibling-record scan or
  // generation inference. Both leave C alive, so the bounded absence probe
  // must time out and fail closed with kill_attempted=0.
  const cases: Case[] = [
    { gen: "y1", killGen: "y0" },
    { gen: "y2", killGen: "y2" },
  ];
  const mkJob = (c: Case) => {
    const label = `org.pix.offline-recovery-probe.${randomUUID()}`;
    return { ...c, label, service: `${domain}/${label}`, plist: join(dir, `job-${c.gen}.plist`) };
  };
  const jobs = cases.map(mkJob);
  const registered = jobs.map(() => false);
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

    // The sibling record for y2: well-formed and internally consistent, built
    // from the live leaf's own authentic identity, but published under
    // generation yr. It is never validated (kill-gen y2 has no record) and
    // never signaled; it exists only to prove the absence of inference.
    const leafIdentity = readFileSync(join(dir, "leaf.json"), "utf8").match(/pid=(\d+) pidversion=(\d+) token=([0-9a-f]{64})/);
    if (!leafIdentity) throw new Error("no identity in leaf.json");
    writeFileSync(join(dir, "postkill-yr.json"),
      `role=postkill gen=yr pid=${leafIdentity[1]} pidversion=${leafIdentity[2]} token=${leafIdentity[3]} killed_at=${Math.floor(Date.now() / 1000)} leaf_deadline=${leafCp.deadline} kill_return=0 kill_errno=0 gone=1 gone_errno=3\n`);

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      writeFileSync(job.plist, supervisorPlist(job.label, supervisorBin, dir, job.gen, ["already-absent-unknown", job.killGen]));
      const bootstrap = launchctl(["bootstrap", domain, job.plist]);
      registered[i] = true;
      expect(bootstrap.status, `${job.gen} bootstrap: ${bootstrap.stderr || bootstrap.error?.message}`).toBe(0);
      await waitFor(() => fileExists(join(dir, `r-${job.gen}.json`)), 5000, `${job.gen} supervisor checkpoint`);
      const rcp = cp(`r-${job.gen}`);
      actors = [...actors, rcp.pid];
      await waitFor(() => fileExists(join(dir, `owner-loss-${job.gen}`)), 20_000, `${job.gen} gate-park marker`);
      writeFileSync(join(dir, `gate-${job.gen}`), "1\n");
      const receiptPath = join(dir, `receipt-${job.gen}.json`);
      // The bounded absence probe holds for ~3s against the live leaf.
      await waitFor(() => fileExists(receiptPath), 10_000, `${job.gen} receipt`);
      const receipt = parseReceipt(receiptPath);
      expect(receipt.status, `${job.gen} must fail closed: ${JSON.stringify(receipt)}`).toBe("fail");
      expect(receipt.stage, `${job.gen} failure stage`).toBe("target-alive");
      expect(receipt.reason, `${job.gen} failure reason`).toBe("not-absent");
      expect(receipt.postkill_record, `${job.gen} must record the genuinely absent record`).toBe("absent");
      expect(Number(receipt.kill_attempted), `${job.gen} must record kill_attempted=0`).toBe(0);
      expect(Number(receipt.kill_return), `${job.gen} must carry the NOT_ATTEMPTED sentinel`).toBe(-2);
      expect(Number(receipt.absent_probe), `${job.gen} absent probe must show the live leaf`).toBe(0);
      expect(Number(receipt.owner_probe), `${job.gen} must still confirm A ESRCH`).toBe(3);
      expect(Number(receipt.helper_probe), `${job.gen} must still confirm B ESRCH`).toBe(3);
      // The fail-closed path never killed anything: C is still alive.
      expect(leafIsAlive(leafCp.pid), `${job.gen} must leave the live leaf untouched`).toBe(true);
      const bootout = launchctl(["bootout", job.service]);
      expect(bootout.status, `${job.gen} bootout: ${bootout.stderr || bootout.error?.message}`).toBe(0);
      expect(launchctl(["print", job.service]).status, `${job.gen} service must be absent`).toBe(113);
      earlyRemoved[i] = true;
      expect(actorsAreAbsent([rcp.pid]), `${job.gen} supervisor must be gone`).toBe(true);
      console.log(`killwindow_neg_case=${job.gen} kill_gen=${job.killGen} stage=target-alive reason=not-absent leaf_alive=1 supervisor_pid=${rcp.pid}`);
    }

    // C dies only by its own independent watchdog, never by any R2 case.
    const watchdogMs = Math.max(0, leafCp.deadline * 1000 - Date.now()) + 8000;
    await waitFor(() => actorsAreAbsent([leafCp.pid]), watchdogMs, "leaf watchdog death after fail-closed cases");
    ok = true;
    console.log(`killwindow_neg_total=${cases.length} leaf_pid=${leafCp.pid} leaf_backstop=${leafCp.deadline}`);
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
