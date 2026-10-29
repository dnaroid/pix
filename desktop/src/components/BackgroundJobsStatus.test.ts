import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import BackgroundJobsStatus from "./BackgroundJobsStatus.svelte";
import statusBarSource from "./StatusBar.svelte?raw";
import type { BackgroundJobsSnapshot } from "../lib/background-jobs";

const noop = () => {};
const handlers = { onKill: noop, onKillAll: noop, onKillOrphans: noop, onOpenLog: noop };
const snapshot: BackgroundJobsSnapshot = {
  checkedAt: 1,
  running: 1,
  jobs: [
    { id: "bg_live", command: "npm run dev", description: "dev server", status: "running", startedAt: 2, logPath: "/w/a.log", tail: "ready on :5173\n" },
    { id: "bg_done", command: "npm test", status: "exited", exitCode: 1, startedAt: 1, endedAt: 3, logPath: "/w/b.log", tail: "1 failed\n" },
  ],
  orphans: [],
};

describe("status bar background jobs indicator", () => {
  it("shows the live job count, tails, Kill only for live jobs and Open log for all", () => {
    const html = render(BackgroundJobsStatus, { props: { snapshot, ...handlers } }).body;
    expect(html).toContain("data-background-jobs-status");
    expect(html).toContain('aria-label="1 background job"');
    expect(html).toContain("lucide-square-terminal");
    expect(html).not.toContain("data-background-jobs-count");
    expect(html).toContain("ready on :5173");
    expect(html).toContain("exited (1)");
    expect(html.match(/data-background-job-kill/g)).toHaveLength(1);
    expect(html.match(/data-background-job-open-log/g)).toHaveLength(2);
    expect(html).not.toContain("data-background-orphans");
  });

  it("warns about orphans left by a previous process", () => {
    const html = render(BackgroundJobsStatus, { props: { snapshot: { ...snapshot, jobs: [], running: 0,
      orphans: [{ pid: 42, command: "node server.js", startedAt: 1, logPath: "/w/c.log", jobId: "bg_old" }] }, ...handlers } }).body;
    expect(html).toContain('aria-label="0 background jobs, 1 orphaned"');
    expect(html).toContain("data-background-orphans");
    expect(html).toContain("pid 42: node server.js");
    expect(html).toContain("text-tool-warning");
  });

  it("renders in the right status section before the plan chip", () => {
    expect(statusBarSource.indexOf("<BackgroundJobsStatus")).toBeGreaterThan(statusBarSource.indexOf("data-status-right"));
    expect(statusBarSource.indexOf("<BackgroundJobsStatus")).toBeLessThan(statusBarSource.indexOf("<SessionPlanStatus"));
  });
});
