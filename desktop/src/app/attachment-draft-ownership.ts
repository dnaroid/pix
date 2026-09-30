type AttachmentDraftOwnershipOptions = {
  invalidate: () => void;
  bumpGeneration: () => void;
};

// Composer transitions restore the target tab synchronously. The later root
// effect must cancel stale additions without clearing that restored snapshot.
export function createAttachmentDraftOwnership(options: AttachmentDraftOwnershipOptions) {
  let previousKey: string | null = null;
  let previousWorkspace: string | null = null;

  function sync(key: string, workspace: string): boolean {
    const keyChanged = previousKey !== null && previousKey !== key;
    const workspaceChanged = previousWorkspace !== null && previousWorkspace !== workspace;
    previousKey = key;
    previousWorkspace = workspace;
    if (workspaceChanged) options.invalidate();
    else if (keyChanged) options.bumpGeneration();
    return keyChanged;
  }

  function retarget(workspace: string, sessionId: string): void {
    previousKey = `${workspace}\0${sessionId}`;
  }

  return { sync, retarget };
}
