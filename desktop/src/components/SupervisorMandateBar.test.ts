import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import type { SupervisorMandateResponse } from "../../../acp/src/acp/supervisor-contract";
import { createSessionRuntimeLoading } from "../app/session-runtime-loading";
import type { AcpClient } from "../lib/acp-client";
import SupervisorMandateBar from "./SupervisorMandateBar.svelte";

const mandate: SupervisorMandateResponse = {
  enabled: true, paused: false, maxConcurrent: 5, maxReworkRounds: 5,
  stalledAfterMinutes: 15, policy: "", running: 0, managed: 0, manual: 0, reworkRounds: 0,
};

describe("supervisor session readiness", () => {
  it.each(["success", "failure"] as const)("tracks the runtime load through %s, not the enabled mandate", async (outcome) => {
    type Response = Awaited<ReturnType<AcpClient["loadSession"]>>;
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const request = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
    const client = { loadSession: () => request } as unknown as AcpClient;
    const reportError = vi.fn();
    let runtimeReady = false;
    const runtime = createSessionRuntimeLoading({
      client: () => client, workspace: () => "/project", activeSessionId: () => "supervisor",
      setActiveReady: (ready) => { runtimeReady = ready; }, setActiveConfigOptions: vi.fn(),
      refreshQueueState: vi.fn(), reportError,
    });
    const header = (savedMandate: SupervisorMandateResponse | null = mandate) => render(SupervisorMandateBar, { props: {
      mandate: savedMandate, runtimeReady, runtimeLoading: runtime.isLoading("supervisor"),
      saving: false, onSetUp: vi.fn(), onEdit: vi.fn(), onPause: vi.fn(),
    } }).body;

    const load = runtime.ensure(client, "supervisor", "/project");
    expect(header()).toMatch(/data-supervisor-runtime-state[^>]*>Starting…<\/span>/);
    expect(header()).toContain(">Enabled</span>");

    const error = new Error("Runtime unavailable");
    if (outcome === "success") resolve({ configOptions: [] });
    else reject(error);
    await load;

    if (outcome === "success") {
      expect(header(null)).toMatch(/data-supervisor-runtime-state[^>]*>Ready<\/span>/);
      expect(header({ ...mandate, paused: true })).toContain(">Paused</span>");
      expect(reportError).not.toHaveBeenCalled();
    } else {
      expect(header()).toMatch(/data-supervisor-runtime-state[^>]*>Not ready<\/span>/);
      expect(reportError).toHaveBeenCalledWith(error);
    }
  });
});
