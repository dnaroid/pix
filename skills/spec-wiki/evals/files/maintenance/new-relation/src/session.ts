export async function refreshSession(loadToken: () => Promise<string>): Promise<string> {
  try {
    return await loadToken();
  } catch {
    return await loadToken();
  }
}
