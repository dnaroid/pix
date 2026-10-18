import { beforeEach, expect, it, vi } from "vitest";
import type { AcpClient, RuntimeStatus } from "../lib/acp-client";
import type { ConnectionStatus } from "./connection.svelte";
import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";

const doubles = vi.hoisted(() => ({ sidebar: vi.fn(), titlebar: vi.fn() }));
vi.mock("./desktop-sidebar-view-model.svelte", () => ({ createDesktopSidebarViewModel: doubles.sidebar }));
vi.mock("./desktop-titlebar-view-model.svelte", () => ({ createDesktopTitlebarViewModel: doubles.titlebar }));
import { createDesktopNavigationViewModelServices } from "./desktop-navigation-view-model-services";

beforeEach(() => vi.clearAllMocks());

it("withholds the sidebar ACP client until initialization, and clears it on failure/reconnect", () => {
  let status: ConnectionStatus = "starting";
  let client: AcpClient | null = {} as AcpClient;
  const live: RuntimeStatus = { sessionId: "live", modelUsageRefresh: "ready" };
  const draft: RuntimeStatus = { sessionId: "draft", modelUsageRefresh: "ready" };
  const noop = () => {};
  // Only the captured sidebar getter is evaluated; unrelated UI dependencies are inert.
  const options = {
    status: () => status, client: () => client,
    transitions: { draft: { openStartTab: noop }, sessionTabs: { deleteSelectedSession: noop, selectSession: noop, closeSessionSelector: noop } },
    workbenchGit: { workbench: { select: noop, close: noop } },
    model: { config: { draftRuntimeStatus: draft } }, project: {}, projectActions: {}, interactions: {},
    sessions: { runtime: { statuses: new Map([["live", live]]) } },
  } as unknown as DesktopViewModelServicesOptions;
  createDesktopNavigationViewModelServices(options);
  const sidebarClient = doubles.sidebar.mock.calls[0]![0].client as () => AcpClient | null;
  const providerStatuses = doubles.sidebar.mock.calls[0]![0].providerStatuses as () => readonly RuntimeStatus[];
  expect(sidebarClient()).toBeNull();
  expect(providerStatuses()).toEqual([]);
  status = "ready";
  expect(sidebarClient()).toBe(client);
  expect(providerStatuses()).toEqual([live, draft]);
  status = "error";
  expect(sidebarClient()).toBeNull();
  expect(providerStatuses()).toEqual([]);
  status = "starting";
  client = {} as AcpClient;
  expect(sidebarClient()).toBeNull();
  status = "ready";
  expect(sidebarClient()).toBe(client);
  client = null;
  status = "stopped";
  expect(sidebarClient()).toBeNull();
});

it("keeps plan runs unavailable until the client is ready and workspace restoration finished", () => {
  let status: ConnectionStatus = "starting";
  let client: AcpClient | null = null;
  let opening = true;
  const noop = () => {};
  const options = {
    status: () => status, client: () => client, clientAvailable: () => client !== null,
    workspaceOpening: () => opening,
    transitions: { draft: { openStartTab: noop }, sessionTabs: { deleteSelectedSession: noop, selectSession: noop, closeSessionSelector: noop } },
    workbenchGit: { workbench: { select: noop, close: noop } },
    model: { config: {} }, project: {}, projectActions: {}, interactions: {}, sessions: {},
  } as unknown as DesktopViewModelServicesOptions;
  createDesktopNavigationViewModelServices(options);
  const planRunReady = doubles.sidebar.mock.calls[0]![0].planRunReady as () => boolean;
  expect(planRunReady()).toBe(false);
  client = {} as AcpClient;
  expect(planRunReady()).toBe(false);
  status = "ready";
  expect(planRunReady()).toBe(false);
  opening = false;
  expect(planRunReady()).toBe(true);
  client = null;
  expect(planRunReady()).toBe(false);
});
