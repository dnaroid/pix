import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const run = (args: string[], timeout = 4000) => spawnSync("launchctl", args, { timeout, encoding: "utf8" });
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

test.skipIf(process.platform !== "darwin" || process.env.PI_OFFLINE_COALITION_PROBE !== "1")("temporary user-domain launchd job has a distinct inherited resource coalition", async () => {
  const domain = `gui/${process.getuid!()}`;
  const probe = run(["print", domain]);
  if (probe.status !== 0) throw new Error(`No user-domain launchd access: ${probe.stderr}`);
  const dir = mkdtempSync(join(tmpdir(), "pi-launchd-coalition-"));
  const label = `org.pix.offline-coalition-probe.${randomUUID()}`;
  const service = `${domain}/${label}`;
  const binary = join(dir, "probe");
  const plist = join(dir, "job.plist");
  const output = join(dir, "job.out");
  let registered = false;
  let cleaned = false;
  let actors: number[] = [];
  let bootstrapped = false;
  try {
    const source = join(import.meta.dir, "fixtures/launchd-coalition-feasibility.c");
    const compile = spawnSync("xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", binary], { timeout: 20_000, encoding: "utf8" });
    expect(compile.status, compile.stderr || compile.error?.message).toBe(0);
    const baseline = spawnSync(binary, ["exec"], { timeout: 9000, encoding: "utf8" });
    expect(baseline.status, baseline.stderr).toBe(0);
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${escapeXml(label)}</string><key>ProgramArguments</key><array><string>${escapeXml(binary)}</string></array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${escapeXml(output)}</string><key>StandardErrorPath</key><string>${escapeXml(join(dir, "job.err"))}</string></dict></plist>`);
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
    const entries = Object.fromEntries([...text.matchAll(/step=(root|fork|setsid|exec) pid=(\d+) resource=(\d+) jetsam=(\d+)/g)].map(m => [m[1], { pid: Number(m[2]), resource: m[3], jetsam: m[4] }]));
    const parent = baseline.stdout.match(/step=exec pid=\d+ resource=(\d+) jetsam=(\d+)/);
    expect(parent).not.toBeNull();
    expect(Object.keys(entries).sort()).toEqual(["exec", "fork", "root", "setsid"]);
    actors = [entries.root.pid, entries.exec.pid];
    expect(entries.root.resource).not.toBe("0");
    expect(entries.root.resource).not.toBe(parent![1]);
    for (const name of ["fork", "setsid", "exec"]) expect(entries[name].resource).toBe(entries.root.resource);
    console.log(`baseline_resource=${parent![1]} job_resource=${entries.root.resource} root_pid=${entries.root.pid} child_pid=${entries.exec.pid} stages=root,fork,setsid,exec`);
  } finally {
    if (registered) {
      const bootout = run(["bootout", service]);
      const scan = run(["print", service]);
      const processScan = actors.length ? spawnSync("ps", ["-p", actors.join(","), "-o", "pid="], { timeout: 4000, encoding: "utf8" }) : null;
      // If bootstrap could have partially launched before failing, or output
      // never listed both actors, retain the owned binary/dir. Their alarms
      // bound lifetime but an absent launchctl record alone is not proof.
      cleaned = !scan.error && scan.status === 113 && bootstrapped && bootout.status === 0 &&
        actors.length === 2 && processScan?.status === 1 && processScan.stdout.trim() === "";
      console.log(`cleanup_service=${service} bootout=${bootout.status} print=${scan.status} actor_ps=${processScan?.status ?? "not-recorded"} actor_pids=${actors.join(",")}`);
      if (!cleaned) console.error(`RESIDUAL_JOB=${service} bootout=${bootout.status} ${bootout.stderr} print=${scan.stdout}`);
    } else cleaned = true;
    if (cleaned) rmSync(dir, { recursive: true, force: true });
    else console.error(`RETAINED_JOB_DIR=${dir}`);
    expect(cleaned, `launchctl job still present: ${service}; owned files retained ${dir}`).toBe(true);
  }
}, 90_000);
