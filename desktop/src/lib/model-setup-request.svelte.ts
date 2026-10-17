/** Lets any Desktop surface (e.g. Settings) ask the model setup dialog to open on demand. */
export const modelSetupRequest = $state({ count: 0 });

export function requestModelSetup(): void {
  modelSetupRequest.count += 1;
}

/** Bumped after the wizard writes configs so open Settings editors re-read them from disk. */
export const userConfigRevision = $state({ count: 0 });

export function notifyUserConfigWritten(): void {
  userConfigRevision.count += 1;
}
