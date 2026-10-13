import { create } from "zustand"
import { useSemanticSettingsStore } from "./store"
import { createEmbeddingWorker, type EmbeddingWorker } from "./workerClient"
import { createSemanticApi } from "./api"
import type { PlexRequestContext } from "../backends/plex/scopedApi"
import type { SemanticMatch } from "./types"
interface DiscoveryState {
  scope: string | null
  status: "disabled" | "loading" | "indexing" | "ready" | "error"
  indexed: number
  progress: number
  error: string | null
}
export const useSemanticDiscovery = create<DiscoveryState>(() => ({
  scope: null,
  status: "disabled",
  indexed: 0,
  progress: 0,
  error: null,
}))
let controller = new AbortController()
let generation = 0
let context: PlexRequestContext | null = null
let worker: EmbeddingWorker | null = null
let opening: Promise<EmbeddingWorker> | null = null
let indexing: Promise<void> | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let dirty = false
function current(owner: number) {
  return (
    owner === generation &&
    !!context &&
    useSemanticSettingsStore.getState().enabled
  )
}
async function model(owner: number) {
  if (worker) return worker
  if (!opening) {
    const request = createEmbeddingWorker(controller.signal)
    opening = request
    request
      .then((value) => {
        if (current(owner)) worker = value
        else value.close()
      })
      .catch(() => {})
      .finally(() => {
        if (opening === request) opening = null
      })
  }
  const value = await opening
  if (!current(owner)) throw new Error("Semantic account changed")
  return value
}
export function activateSemanticContext(value: PlexRequestContext | null) {
  controller.abort()
  controller = new AbortController()
  generation++
  context = value ? Object.freeze({ ...value }) : null
  worker?.close()
  worker = null
  opening = null
  indexing = null
  dirty = false
  if (timer) clearTimeout(timer)
  timer = null
  useSemanticDiscovery.setState({
    scope: value?.cacheScope ?? null,
    status: "disabled",
    indexed: 0,
    progress: 0,
    error: null,
  })
  if (value && useSemanticSettingsStore.getState().enabled)
    void useSemanticSettingsStore
      .getState()
      .checkInstalled()
      .then(() => refreshSemanticIndex())
}
export function scheduleSemanticIndex() {
  if (!context || !useSemanticSettingsStore.getState().enabled) return
  dirty = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void refreshSemanticIndex()
  }, 750)
}
export async function refreshSemanticIndex(): Promise<void> {
  if (indexing) {
    dirty = true
    return indexing
  }
  if (
    !context ||
    !useSemanticSettingsStore.getState().enabled ||
    !useSemanticSettingsStore.getState().installed
  )
    return
  const owner = generation
  const api = createSemanticApi(context)
  dirty = false
  const run = (async () => {
    try {
      useSemanticDiscovery.setState({ status: "loading", error: null })
      const engine = await model(owner)
      if (!current(owner)) return
      const documents = (await api.documents()).slice(0, 2000)
      if (!current(owner)) return
      const missing = documents.filter((doc) => !doc.indexed)
      let done = 0
      useSemanticDiscovery.setState({
        status: "indexing",
        indexed: documents.length - missing.length,
        progress: missing.length ? 0 : 1,
      })
      for (let start = 0; start < missing.length; start += 16) {
        if (!current(owner)) return
        const batch = missing.slice(start, start + 16)
        const vectors = await engine.embed(
          batch.map((doc) => doc.text.slice(0, 12000))
        )
        if (!current(owner)) return
        await api.put(
          batch.map((doc, index) => ({
            kind: doc.kind,
            id: doc.id,
            textHash: doc.textHash,
            vector: vectors[index],
          }))
        )
        if (!current(owner)) return
        done += batch.length
        useSemanticDiscovery.setState({
          indexed: documents.length - missing.length + done,
          progress: done / missing.length,
        })
      }
      if (current(owner))
        useSemanticDiscovery.setState({ status: "ready", progress: 1 })
    } catch {
      if (current(owner)) {
        worker?.close()
        worker = null
      }
      if (current(owner))
        useSemanticDiscovery.setState({
          status: "error",
          error: "Saved pages could not be indexed locally. Retry in Settings.",
        })
    }
  })()
  indexing = run
  try {
    await run
  } finally {
    if (indexing === run) indexing = null
    if (current(owner) && dirty) scheduleSemanticIndex()
  }
}
export async function searchSemantic(
  query: string,
  limit = 20
): Promise<SemanticMatch[]> {
  if (
    !context ||
    !useSemanticSettingsStore.getState().enabled ||
    !useSemanticSettingsStore.getState().installed
  )
    throw new Error(
      "Enable and download local semantic discovery in Settings first."
    )
  const normalized = query.trim()
  if (!normalized || normalized.length > 512)
    throw new Error("Enter a description of up to 512 characters.")
  const owner = generation
  const api = createSemanticApi(context)
  const engine = await model(owner)
  const vectors = await engine.embed([normalized])
  if (!current(owner)) throw new Error("Semantic account changed")
  const results = await api.search(vectors[0], limit)
  if (!current(owner)) throw new Error("Semantic account changed")
  return results
}
let previousEnabled = useSemanticSettingsStore.getState().enabled
useSemanticSettingsStore.subscribe((state) => {
  if (state.enabled !== previousEnabled) {
    previousEnabled = state.enabled
    if (!state.enabled) {
      const saved = context
      activateSemanticContext(saved)
    } else scheduleSemanticIndex()
  } else if (state.enabled && state.installed) scheduleSemanticIndex()
})
