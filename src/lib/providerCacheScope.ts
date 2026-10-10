/** No credential, server address or library name appears in an IndexedDB key. */
export async function providerCacheScope(
  backend: string,
  server: string,
  credential: string,
  library: string,
  baseUrl: string
): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null
  const input = new TextEncoder().encode(JSON.stringify([backend, server, credential, library, baseUrl]))
  const hash = await crypto.subtle.digest("SHA-256", input)
  return `${backend}-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
