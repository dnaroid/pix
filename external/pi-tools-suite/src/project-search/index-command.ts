import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INDEX_SOURCES, runSourceIndex, type IndexResult, type IndexSource } from "./index-runner.js";
import { readIndexStatus } from "./index-status.js";

const usage = "Usage: /search-index code|knowledge|sessions|tasks|commits|all|status|cancel [source|all]";
const isSource = (value: string): value is IndexSource => INDEX_SOURCES.includes(value as IndexSource);
type Job = { abort: AbortController; settled: Promise<void>; state: string };
interface CommandServices {
  run?: typeof runSourceIndex;
  status?: typeof readIndexStatus;
}

/** One session owner; cancellation retains deduplication until actual settlement. */
export function registerSearchIndexCommand(pi: ExtensionAPI, services: CommandServices = {}): void {
  let owner: { root: string; ctx: ExtensionContext; jobs: Map<IndexSource, Job>; live: boolean } | undefined;
  let retiring: Promise<unknown> = Promise.resolve();
  let epoch = 0;
  const reset = () => {
    epoch++;
    const old = owner;
    owner = undefined;
    if (old) {
      old.live = false;
      old.ctx.ui.setStatus("search-index", undefined);
      for (const job of old.jobs.values()) job.abort.abort();
      retiring = Promise.all([retiring, ...[...old.jobs.values()].map(job => job.settled)]);
    }
    return retiring.then(() => {});
  };
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.registerCommand("search-index", {
    description: "Index code, knowledge, sessions, tasks or commits; all | status | cancel [source|all]. Uses the configured provider; charges may apply.",
    getArgumentCompletions: prefix => {
      const cancel = prefix.startsWith("cancel ");
      return (cancel ? [...INDEX_SOURCES, "all"].map(source => `cancel ${source}`)
        : [...INDEX_SOURCES, "all", "status", "cancel"]).filter(value => value.startsWith(prefix))
        .map(value => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const [action = "status", target, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (extra.length || (action !== "cancel" && target) || (!isSource(action) && !["all", "status", "cancel"].includes(action))
        || (action === "cancel" && target && target !== "all" && !isSource(target))) {
        ctx.ui.notify(usage, "warning"); return;
      }
      if (owner && owner.root !== resolve(ctx.cwd)) void reset();
      const generation = epoch;
      await retiring;
      if (generation !== epoch) return;
      const current = owner ??= { root: resolve(ctx.cwd), ctx, jobs: new Map(), live: true };
      const refresh = () => {
        if (!current.live) return;
        const active = [...current.jobs].filter(([, job]) => ["running", "stopping"].includes(job.state));
        ctx.ui.setStatus("search-index", active.length ? active.map(([source, job]) => `${source}: ${job.state}`).join(" · ") : undefined);
      };
      if (action === "status") {
        const lines = await (services.status ?? readIndexStatus)(current.root).catch(() => ["Stored indexes unavailable."]);
        if (current.live) ctx.ui.notify([...lines, ...[...current.jobs].map(([source, job]) => `${source}: ${job.state}`),
          "Stored counts are not freshness/coverage. Runs shown belong to this session. Provider: /search-semantic status."].join("\n"), "info");
        return;
      }
      if (action === "cancel") {
        let count = 0;
        for (const [source, job] of current.jobs) {
          if (target && target !== "all" && target !== source) continue;
          if (!["running", "stopping"].includes(job.state)) continue;
          job.state = "stopping"; job.abort.abort(); count++;
        }
        refresh();
        ctx.ui.notify(count ? "Stopping owned indexing runs; committed batches are retained." : "No matching active indexing runs in this session.", "info");
        return;
      }
      const sources = action === "all" ? INDEX_SOURCES : [action as IndexSource];
      for (const source of sources) {
        if (["running", "stopping"].includes(current.jobs.get(source)?.state ?? "")) {
          ctx.ui.notify(`${source}: already running or stopping.`, "info"); continue;
        }
        const job: Job = { abort: new AbortController(), settled: Promise.resolve(), state: "running" };
        current.jobs.set(source, job);
        ctx.ui.notify(`${source}: indexing started. Configured provider charges may apply. /search-index cancel ${source} to stop.`, "info");
        job.settled = Promise.resolve().then(() => (services.run ?? runSourceIndex)(current.root, source, job.abort.signal))
          .then((result: IndexResult) => {
            job.state = job.abort.signal.aborted ? "cancelled" : result.complete ? "complete" : "partial";
            if (current.live) ctx.ui.notify(`${source}: ${job.state}${result.indexed === undefined ? "" : ` (${result.indexed} indexed)`}. ${job.abort.signal.aborted ? "Committed batches retained." : result.message ?? ""}`, result.complete ? "info" : "warning");
          }, () => {
            job.state = job.abort.signal.aborted ? "cancelled" : "error";
            if (current.live) ctx.ui.notify(`${source}: ${job.state}. Cached batches retained; check provider configuration/credentials and storage, then rerun /search-index ${source}.`, "warning");
          }).finally(refresh);
      }
      refresh();
    },
  });
}
