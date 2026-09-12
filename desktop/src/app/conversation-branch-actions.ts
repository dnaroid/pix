import type { ConversationBranchActionsOptions } from "./conversation-branch-options";
import { createForkConversation } from "./conversation-fork-action";
import { createUserMessageContextActions } from "./user-message-context-actions";

export type { UserMessageContextAction } from "./user-message-context-actions";

export function createConversationBranchActions(options: ConversationBranchActionsOptions) {
  const forkConversation = createForkConversation(options);
  const messages = createUserMessageContextActions(options, forkConversation);

  return {
    forkConversation,
    runUserMessageContextAction: messages.runUserMessageContextAction,
  };
}
