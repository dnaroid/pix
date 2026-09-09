export async function refreshInBackground(loadToken: () => Promise<string>): Promise<string> {
  try {
    return await loadToken();
  } catch {
    return await loadToken();
  }
}
