export type TokenLoader = () => Promise<string>;

export async function refreshSession(loadToken: TokenLoader): Promise<string> {
  return loadToken();
}
