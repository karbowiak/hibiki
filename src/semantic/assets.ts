import { createStore, get, set } from "idb-keyval"
import {
  SEMANTIC_ASSETS,
  SEMANTIC_MODEL_ID,
  type SemanticAsset,
} from "./manifest"
const store = createStore("hibiki-semantic-public-model", "assets")
export interface AssetStorage {
  get(name: string): Promise<unknown>
  put(name: string, bytes: ArrayBuffer): Promise<void>
}
const storage: AssetStorage = {
  get: (name) => get(name, store),
  put: (name, bytes) => set(name, bytes, store),
}
export async function validateAsset(
  asset: SemanticAsset,
  bytes: ArrayBuffer
): Promise<void> {
  if (bytes.byteLength !== asset.bytes)
    throw new Error("Local model asset has an unexpected size")
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (x) => x.toString(16).padStart(2, "0")
  ).join("")
  if (hash !== asset.sha256)
    throw new Error("Local model asset failed integrity verification")
}
export async function installedAssets(
  backend: AssetStorage = storage
): Promise<{ name: string; bytes: ArrayBuffer }[] | null> {
  const result = []
  for (const asset of SEMANTIC_ASSETS) {
    const value = await backend.get(`${SEMANTIC_MODEL_ID}:${asset.name}`)
    if (!(value instanceof ArrayBuffer)) return null
    await validateAsset(asset, value)
    result.push({ name: asset.name, bytes: value })
  }
  return result
}
/** Only called by an explicit settings action, never during app startup/search. */
export async function installAssets(
  progress: (completed: number, total: number) => void,
  backend: AssetStorage = storage,
  download: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<void> {
  let completed = 0
  for (const asset of SEMANTIC_ASSETS) {
    const old = await backend.get(`${SEMANTIC_MODEL_ID}:${asset.name}`)
    if (old instanceof ArrayBuffer) {
      try {
        await validateAsset(asset, old)
        completed++
        progress(completed, SEMANTIC_ASSETS.length)
        continue
      } catch {
        /* Preserve old bytes until a verified replacement exists. */
      }
    }
    const response = await download(asset.url, {
      credentials: "omit",
      redirect: "follow",
      signal: signal ?? AbortSignal.timeout(120000),
    })
    if (!response.ok || !response.body)
      throw new Error("Local model download failed")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > asset.bytes)
          throw new Error("Local model download exceeds its limit")
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    await validateAsset(asset, bytes.buffer)
    await backend.put(`${SEMANTIC_MODEL_ID}:${asset.name}`, bytes.buffer)
    completed++
    progress(completed, SEMANTIC_ASSETS.length)
  }
}
