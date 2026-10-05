import {
  buildWorkbenchConversationProps,
  buildWorkbenchEditorProps,
  buildWorkbenchShellProps,
  type DesktopWorkbenchSurfaceViewProps,
  type WorkbenchConversationBuilderOptions,
  type WorkbenchEditorBuilderOptions,
  type WorkbenchShellBuilderOptions,
} from "./desktop-workbench-prop-builders";

type DesktopWorkbenchViewModelOptions = {
  layout: {
    conversationVisible: () => boolean;
    conversationLabelledBy: () => string | undefined;
  };
  shell: WorkbenchShellBuilderOptions;
  conversation: WorkbenchConversationBuilderOptions;
  editor: WorkbenchEditorBuilderOptions;
};

export function createDesktopWorkbenchViewModel(options: DesktopWorkbenchViewModelOptions) {
  const props = $derived.by<DesktopWorkbenchSurfaceViewProps>(() => ({
    conversationVisible: options.layout.conversationVisible(),
    conversationLabelledBy: options.layout.conversationLabelledBy(),
    ...buildWorkbenchShellProps(options.shell),
    ...buildWorkbenchConversationProps(options.conversation),
    ...buildWorkbenchEditorProps(options.editor),
  }));

  return {
    get props() { return props; },
  };
}
