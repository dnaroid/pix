export interface InvoicePreview {
  accountId: string;
  amountCents: number;
  dryRun: boolean;
}

export function buildInvoicePreview(accountId: string, amountCents: number): InvoicePreview {
  // Decoy: billing previews use the obvious dryRun word but do not touch renewal markers.
  return { accountId, amountCents, dryRun: true };
}
