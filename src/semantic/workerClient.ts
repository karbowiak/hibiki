import { installedAssets } from "./assets"
export interface EmbeddingWorker {
  embed(texts: string[]): Promise<number[][]>
  close(): void
}
export async function createEmbeddingWorker(
  signal?: AbortSignal
): Promise<EmbeddingWorker> {
  const assets = await installedAssets()
  if (!assets)
    throw new Error("Download the local semantic model in Settings first.")
  if (signal?.aborted)
    throw new Error("Local semantic initialization was retired")
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  })
  let sequence = 0
  let closed = false
  let queued = 0
  let chain: Promise<unknown> = Promise.resolve()
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const close = () => {
    if (closed) return
    closed = true
    signal?.removeEventListener("abort", close)
    worker.terminate()
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error("Local semantic request was retired"))
    }
    pending.clear()
  }
  signal?.addEventListener("abort", close, { once: true })
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id)
    clearTimeout(request.timer)
    if (data.error) request.reject(new Error("Local semantic inference failed"))
    else request.resolve(data.result)
  }
  worker.onerror = close
  function call(
    type: string,
    payload: Record<string, unknown>,
    transfer: Transferable[] = []
  ): Promise<unknown> {
    if (closed)
      return Promise.reject(new Error("Local semantic worker is unavailable"))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error("Local semantic inference timed out"))
        close()
      }, 60000)
      pending.set(id, { resolve, reject, timer })
      worker.postMessage({ id, type, ...payload }, transfer)
    })
  }
  try {
    await call(
      "initialize",
      { assets },
      assets.map((asset) => asset.bytes)
    )
  } catch (error) {
    close()
    throw error
  }
  return {
    embed(texts) {
      if (
        texts.length < 1 ||
        texts.length > 32 ||
        texts.some((text) => text.length > 12000)
      )
        return Promise.reject(new Error("Invalid local semantic batch"))
      if (queued >= 4)
        return Promise.reject(new Error("Local semantic request queue is full"))
      queued++
      const request = chain.then(() => call("embed", { texts }))
      chain = request.catch(() => {})
      return request
        .then((result) => result as number[][])
        .finally(() => {
          queued--
        })
    },
    close,
  }
}
