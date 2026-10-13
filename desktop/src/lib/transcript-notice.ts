/** Presentation only: notices never change agent execution/control state. */
export function transcriptNotice(messageId: string | undefined, text: string): {
  title: string;
  severity: "warning" | "error";
} | undefined {
  if (messageId?.startsWith("pix-system:error:")) {
    return { title: "Agent stopped with an error", severity: "error" };
  }
  if (messageId?.startsWith("pix-system:notification:error:")) {
    return { title: "Extension error", severity: "error" };
  }
  // Also style rate-limit rows already received from older ACP hosts, which
  // did not carry severity. Do not guess severity for arbitrary system text.
  const legacyRateLimit = messageId?.startsWith("pix-system:")
    && text.startsWith("[pi-claude-code-provider] Claude rate limit warning:");
  if (messageId?.startsWith("pix-system:notification:warning:") || legacyRateLimit) {
    return { title: "Warning", severity: "warning" };
  }
  return undefined;
}
