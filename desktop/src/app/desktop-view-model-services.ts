import { createDesktopNavigationViewModelServices } from "./desktop-navigation-view-model-services";
import { createDesktopShellViewModelServices } from "./desktop-shell-view-model-services";
import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";
import { createDesktopWorkbenchViewModelServices } from "./desktop-workbench-view-model-services";

export function createDesktopViewModelServices(options: DesktopViewModelServicesOptions) {
  const navigation = createDesktopNavigationViewModelServices(options);
  const workbench = createDesktopWorkbenchViewModelServices(options);
  const shell = createDesktopShellViewModelServices(options);

  return {
    titlebar: navigation.titlebar,
    sidebar: navigation.sidebar,
    workbench,
    overlays: shell.overlays,
    statusBar: shell.statusBar,
  };
}

export type DesktopViewModelServices = ReturnType<typeof createDesktopViewModelServices>;
