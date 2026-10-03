import { createDesktopNavigationViewModelServices } from "./desktop-navigation-view-model-services";
import { createDesktopShellViewModelServices } from "./desktop-shell-view-model-services";
import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";
import { createDesktopWorkbenchViewModelServices } from "./desktop-workbench-view-model-services";
import { createSessionTodoActions } from "./session-todo-actions";

export function createDesktopViewModelServices(options: DesktopViewModelServicesOptions) {
  const todoActions = createSessionTodoActions({
    client: options.client,
    ready: (sessionId) => sessionId === options.state.sessionId
      && options.state.runtimeReady
      && !options.presentation.promptRunning
      && !options.presentation.sessionMutationRunning
      && !options.presentation.activeBrainstormLink?.owned
      && !options.sessions.history.loading,
    reportError: (error) => options.errors.report(error),
  });
  const navigation = createDesktopNavigationViewModelServices(options);
  const workbench = createDesktopWorkbenchViewModelServices(options, todoActions);
  const shell = createDesktopShellViewModelServices(options, todoActions);

  return {
    titlebar: navigation.titlebar,
    sidebar: navigation.sidebar,
    workbench,
    overlays: shell.overlays,
    statusBar: shell.statusBar,
  };
}

export type DesktopViewModelServices = ReturnType<typeof createDesktopViewModelServices>;
