import { createDiagnosticLogger } from "./diagnostic-logging";

export type DeletionOptions = { title: string; okLabel?: string };
export type DeletionRequest = DeletionOptions & {
  message: string;
  finish: (confirmed: boolean) => void;
};

/** One pending decision per window. Overlapping requests fail closed, not queued. */
export function createDeletionConfirmation(report: (error: unknown) => void) {
  let present: ((request: DeletionRequest | null) => void) | undefined;
  let pending: DeletionRequest | undefined;

  function notify(request: DeletionRequest | null): void {
    try { present?.(request); }
    catch (error) {
      report(error);
      request?.finish(false);
    }
  }

  function attach(presenter: NonNullable<typeof present>): () => void {
    if (present) throw new Error("Deletion confirmation host is already mounted");
    present = presenter;
    return () => {
      if (present !== presenter) return;
      present = undefined;
      pending?.finish(false);
    };
  }

  function confirm(message: string, options: DeletionOptions): Promise<boolean> {
    if (!present) {
      report(new Error("Deletion confirmation host is unavailable"));
      return Promise.resolve(false);
    }
    if (pending) return Promise.resolve(false);
    return new Promise(resolve => {
      const request: DeletionRequest = {
        ...options, message,
        finish(confirmed) {
          if (pending !== request) return;
          pending = undefined;
          resolve(confirmed === true);
          notify(null);
        },
      };
      pending = request;
      notify(request);
    });
  }

  return { attach, confirm };
}

const diagnostics = createDiagnosticLogger(() => ({ workspace: "" }));
const confirmation = createDeletionConfirmation(error => diagnostics.report(error));
export const attachDeletionConfirmation = confirmation.attach;
export const confirmDesktopDeletion = confirmation.confirm;
