import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const run = (args: string[], timeout = 4000) => spawnSync("launchctl", args, { timeout, encoding: "utf8" });
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

test.skipIf(process.platform !== "darwin" || process.env.PI_OFFLINE_COALITION_PROBE !== "1")("coalition_info resource counters stay nonzero after own-UUID launchd leader dies while noncooperative setsid+exec descendant lives, then reach actual zero (not ESRCH) after exact-token kill", async () => {
  const domain = `gui/${process.getuid!()}`;
  const probe = run(["print", domain]);
  if (probe.status !== 0) throw new Error(`No user-domain launchd access: ${probe.stderr}`);
  const dir = mkdtempSync(join(tmpdir(), "pi-launchd-coalition-accounting-"));
  const label = `org.pix.offline-coalition-accounting.${randomUUID()}`;
  const service = `${domain}/${label}`;
  const binary = join(dir, "probe");
  const plist = join(dir, "job.plist");
  const output = join(dir, "job.out");
  let registered = false;
  let cleaned = false;
  let actors: number[] = [];
  let bootstrapped = false;
  try {
    const source = join(import.meta.dir, "fixtures/launchd-coalition-accounting.c");
    const compile = spawnSync("xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", source, "-lbsm", "-o", binary], { timeout: 20_000, encoding: "utf8" });
    expect(compile.status, compile.stderr || compile.error?.message).toBe(0);
    // The descendant is an unmodified /bin/sleep with its own bounded 45s expiry;
    // every other actor (leader alarm, probe alarm, test timeout) is bounded too.
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${escapeXml(label)}</string><key>ProgramArguments</key><array><string>${escapeXml(binary)}</string><string>leader</string><string>45</string></array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${escapeXml(output)}</string><key>StandardErrorPath</key><string>${escapeXml(join(dir, "job.err"))}</string></dict></plist>`);
    const bootstrap = run(["bootstrap", domain, plist]);
    // Even a failed bootstrap might have installed a job: bootout exact identity in finally.
    registered = true;
    expect(bootstrap.status, bootstrap.stderr || bootstrap.error?.message).toBe(0);
    bootstrapped = true;
    let text = "";
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      text = existsSync(output) ? readFileSync(output, "utf8") : "";
      if (text.includes("done=1")) break;
      await Bun.sleep(50);
    }
    expect(text).toContain("done=1");
    const leader = text.match(/step=leader pid=(\d+) resource=(\d+) jetsam=(\d+) child=(\d+) leader_uniqueid=(\d+) child_uniqueid=(\d+)/);
    expect(leader).not.toBeNull();
    actors = [Number(leader![1]), Number(leader![4])];
    // The external probe runs in the test's own coalition, outside the job's.
    // child_uniqueid gives the probe generation-precise death confirmation.
    const accounting = spawnSync(binary, ["probe", leader![2], leader![4], leader![1], leader![5], leader![6]], { timeout: 40_000, encoding: "utf8" });
    expect(accounting.status, `${accounting.stdout}\n${accounting.stderr}\n${accounting.error?.message}`).toBe(0);
    const summary = accounting.stdout.match(/phase1_started=(\d+) phase1_exited=(\d+) phase1_live=(-?\d+) phase2_started=(\d+) phase2_exited=(\d+) zero_read=(\d+) esrch_seen=(\d+) child_dead=(\d+) esrch_after=(\d+)/);
    expect(summary).not.toBeNull();
    // Exact totals are host-kernel-specific (launchd spawn and each exec add a
    // transient +1 started/+1 exited on this host); the oracle is the diff.
    expect(Number(summary![3])).toBe(1); // leader dead, noncooperative descendant alive
    expect(Number(summary![4])).toBe(Number(summary![1])); // nothing joined between reads
    expect(Number(summary![5])).toBe(Number(summary![4])); // actual zero read: started == exited
    expect(summary![6]).toBe("1"); // zero observed as a successful read, ...
    expect(summary![7]).toBe("0"); // ... not as ESRCH from a reaped coalition
    expect(summary![8]).toBe("1"); // exact generation provably gone after the kill
    console.log(`job_resource=${leader![2]} leader_pid=${leader![1]} child_pid=${leader![4]} child_uniqueid=${leader![6]} ${accounting.stdout.trim()}`);
  } finally {
    if (registered) {
      const bootout = run(["bootout", service]);
      const scan = run(["print", service]);
      const processScan = actors.length ? spawnSync("ps", ["-p", actors.join(","), "-o", "pid="], { timeout: 4000, encoding: "utf8" }) : null;
      // Retain on uncertainty: a spawn error/timeout, unexpected stderr from
      // bootout or ps, a wrong exit code, or unrecorded actors keeps the
      // owned binary/dir. (launchctl print of a removed job legitimately
      // exits 113 with a stderr message, so only its spawn error is rejected
      // there.) If bootstrap could have partially launched before failing, or
      // output never listed both actors, retain too. The descendant's own 45s
      // expiry bounds its lifetime; an absent launchctl record alone is not
      // proof.
      const spawnOk = (r: { error?: Error | null; status: number | null; stdout: string; stderr: string } | null): r is { error?: Error | null; status: number; stdout: string; stderr: string } =>
        !!r && !r.error && typeof r.status === "number";
      cleaned = bootstrapped && actors.length === 2 &&
        spawnOk(bootout) && bootout.status === 0 && !bootout.stderr.trim() &&
        spawnOk(scan) && scan.status === 113 &&
        spawnOk(processScan) && processScan.status === 1 &&
        processScan.stdout.trim() === "" && !processScan.stderr.trim();
      console.log(`cleanup_service=${service} bootout=${bootout.status} print=${scan.status} actor_ps=${processScan?.status ?? "not-recorded"} actor_pids=${actors.join(",")}`);
      if (!cleaned) console.error(`RESIDUAL_JOB=${service} bootout=${bootout.status} ${bootout.stderr} print=${scan.stdout}`);
    } else cleaned = true;
    if (cleaned) rmSync(dir, { recursive: true, force: true });
    else console.error(`RETAINED_JOB_DIR=${dir}`);
    expect(cleaned, `launchctl job still present: ${service}; owned files retained ${dir}`).toBe(true);
  }
}, 120_000);
