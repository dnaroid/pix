import { beforeEach, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
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
  const noop = () => {};
  // Only the captured sidebar getter is evaluated; unrelated UI dependencies are inert.
  const options = {
    status: () => status, client: () => client,
    transitions: { draft: { openStartTab: noop }, sessionTabs: { deleteSelectedSession: noop, selectSession: noop, closeSessionSelector: noop } },
    workbenchGit: { workbench: { select: noop, close: noop } },
    model: {}, project: {}, projectActions: {}, interactions: {},
  } as unknown as DesktopViewModelServicesOptions;
  createDesktopNavigationViewModelServices(options);
  const sidebarClient = doubles.sidebar.mock.calls[0]![0].client as () => AcpClient | null;
  expect(sidebarClient()).toBeNull();
  status = "ready";
  expect(sidebarClient()).toBe(client);
  status = "error";
  expect(sidebarClient()).toBeNull();
  status = "starting";
  client = {} as AcpClient;
  expect(sidebarClient()).toBeNull();
  status = "ready";
  expect(sidebarClient()).toBe(client);
  client = null;
  status = "stopped";
  expect(sidebarClient()).toBeNull();
});
