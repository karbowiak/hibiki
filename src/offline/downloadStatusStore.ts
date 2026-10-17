import { create } from "zustand"
import { useProviderStore } from "../stores/providerStore"
import { useCatalogueStore } from "./catalogueStore"
import {
  createEntityDownloads,
  type DownloadOwner,
  type DownloadEntity,
  type EntityDownloadStatus,
} from "./downloadEntities"

const key = (item: DownloadEntity) => `${item.kind}:${item.id}`
export const useDownloadStatusStore = create<{
  statuses: Record<string, EntityDownloadStatus>
}>()(() => ({ statuses: {} }))
let owner: DownloadOwner | null = null
let epoch = 0,
  pending = false,
  dirty = false
let timer: ReturnType<typeof setInterval> | null = null
const visible = new Map<string, { entity: DownloadEntity; refs: Set<symbol> }>()
let pruning = false
function pruneStatuses() {
  if (pruning) return
  pruning = true
  queueMicrotask(() => {
    pruning = false
    useDownloadStatusStore.setState(state => {
      const entries = Object.entries(state.statuses).filter(([id]) => visible.has(id))
      return entries.length === Object.keys(state.statuses).length ? state : { statuses: Object.fromEntries(entries) }
    })
  })
}
function publishStatuses(statuses: EntityDownloadStatus[]) {
  useDownloadStatusStore.setState(state => {
    const updates = statuses.filter(status => {
      const id = `${status.kind}:${status.id}`
      if (!visible.has(id)) return false
      const old = state.statuses[id]
      return !old || Object.keys(status).some(field => old[field] !== status[field]) ||
        Object.keys(old).some(field => old[field] !== status[field])
    })
    return updates.length ? { statuses: { ...state.statuses, ...Object.fromEntries(updates.map(status => [`${status.kind}:${status.id}`, status])) } } : state
  })
}
export function captureDownloadOwner(): DownloadOwner | null {
  const provider = useProviderStore.getState().provider,
    context = useCatalogueStore.getState().context
  return provider && context && provider.cacheScope === context.cacheScope
    ? { provider, context: { ...context }, session: provider.playbackSession }
    : null
}
export function ownsDownloads(captured: DownloadOwner): boolean {
  const latest = captureDownloadOwner()
  return (
    !!latest &&
    latest.provider === captured.provider &&
    latest.session === captured.session &&
    latest.context.connectionRevision === captured.context.connectionRevision &&
    latest.context.cacheScope === captured.context.cacheScope
  )
}
function activate(captured: DownloadOwner) {
  if (
    owner &&
    ownsDownloads(owner) &&
    owner.provider === captured.provider &&
    owner.session === captured.session
  )
    return
  ++epoch
  owner = captured
  pending = false
  visible.clear()
  useDownloadStatusStore.setState({ statuses: {} })
  if (timer) clearInterval(timer)
  timer = setInterval(refreshDownloadStatuses, 5000)
}
export function registerDownloadStatus(
  captured: DownloadOwner,
  entity: DownloadEntity
): () => void {
  if (!ownsDownloads(captured)) return () => {}
  activate(captured)
  const token = Symbol(),
    id = key(entity),
    entry = visible.get(id) ?? { entity, refs: new Set<symbol>() }
  entry.refs.add(token)
  visible.set(id, entry)
  if (!timer) timer = setInterval(refreshDownloadStatuses, 5000)
  refreshDownloadStatuses()
  return () => {
    const entry = visible.get(id)
    entry?.refs.delete(token)
    if (entry && !entry.refs.size) {
      visible.delete(id)
      pruneStatuses()
    }
    if (!visible.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
export function refreshDownloadStatuses() {
  dirty = true
  queueMicrotask(() => void flush())
}
async function flush() {
  if (pending || !dirty || !owner || !ownsDownloads(owner) || !visible.size)
    return
  dirty = false
  pending = true
  const captured = owner,
    generation = epoch,
    entities = [...visible.values()].map((value) => value.entity)
  const api = createEntityDownloads(
    captured,
    () => generation === epoch && ownsDownloads(captured)
  )
  try {
    for (let start = 0; start < entities.length; start += 200) {
      const statuses = await api.status(entities.slice(start, start + 200))
      if (generation !== epoch || !ownsDownloads(captured)) return
      publishStatuses(statuses)
    }
  } catch {
    /* Old native builds or storage failures do not invent download status. */
  } finally {
    if (generation === epoch) {
      pending = false
      if (dirty) queueMicrotask(() => void flush())
    }
  }
}
// A retired native/account owner immediately loses its visible badges.
function retire() {
  if (owner && !ownsDownloads(owner)) {
    ++epoch
    owner = null
    pending = false
    visible.clear()
    if (timer) clearInterval(timer)
    timer = null
    useDownloadStatusStore.setState({ statuses: {} })
  }
}
useProviderStore.subscribe(retire)
useCatalogueStore.subscribe(retire)
