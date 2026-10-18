import { listen } from "@tauri-apps/api/event"
import { isTauri } from "@tauri-apps/api/core"
import type { MusicProvider } from "../providers/types"
import { useProviderStore } from "../stores/providerStore"
import { createMatchingChangePump } from "./changePump"
import type { MatchingChanges } from "./resolverTypes"

export type MatchingUpdate = MatchingChanges & { provider: MusicProvider; coverageChanged: boolean }
const listeners = new Set<(update: MatchingUpdate) => void>()
export function subscribeMatchingUpdates(listener: (update: MatchingUpdate) => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export { matchingUpdateAffects, matchingUpdateAffectsRecording, matchingKey } from "./changes"
export function startMatchingUpdates() {
  if (!isTauri()) return () => {}
  let disposed = false, detach: (() => void) | undefined
  let owner: { provider: MusicProvider | null; session: unknown; scope: unknown } | undefined
  let pump: ReturnType<typeof createMatchingChangePump> | undefined
  const select = () => {
    const provider = useProviderStore.getState().provider, session = provider?.playbackSession, scope = provider?.cacheScope
    if (owner?.provider === provider && owner?.session === session && owner?.scope === scope) return
    pump?.stop(); pump = undefined
    const identity = owner = { provider, session, scope }
    if (!provider?.matchingChanges) return
    const current = () => !disposed && owner === identity && useProviderStore.getState().provider === provider && provider.playbackSession === session && provider.cacheScope === scope
    pump = createMatchingChangePump({ current, read: cursor => provider.matchingChanges!(cursor),
      publish: update => { if (current()) for (const listener of listeners) { try { listener({ ...update, provider }) } catch { /* One view cannot strand the other consumers. */ } } },
    })
    pump.offer()
  }
  const unsubscribe = useProviderStore.subscribe(select)
  select()
  void listen<{ scope: string }>("matching-index-changed", event => {
    if (event.payload.scope === owner?.scope) pump?.offer()
  }).then(cleanup => { if (disposed) cleanup(); else detach = cleanup }).catch(() => {})
  return () => { disposed = true; pump?.stop(); unsubscribe(); detach?.() }
}
