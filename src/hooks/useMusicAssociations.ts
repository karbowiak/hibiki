import { useEffect, useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import type { MusicItem } from "../types/music"
import { useProviderStore } from "../stores/providerStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import { associateMusicItems } from "../matching/associations"
import { subscribeMatchingUpdates } from "../matching/updates"

/** Visible identity evidence only; no remote searches or metadata hydration. */
export function useMusicAssociations(items: MusicItem[]) {
  const { provider, session, scope } = useProviderStore(useShallow(state => ({ provider: state.provider,
    session: state.provider?.playbackSession, scope: state.provider?.cacheScope })))
  const account = useYoutubeMusicDiscoveryStore(state => `${state.accountId}:${state.revision}:${state.connected}`)
  const key = JSON.stringify(items.filter(item => item.id.startsWith("ytmusic:") && item.type !== "playlist").slice(0, 256))
  const identity = useMemo(() => ({}), [provider, session, scope, account, key])
  const [revision, setRevision] = useState(0)
  const [value, setValue] = useState<{ identity: object; matches: Map<string, string | null> }>()
  useEffect(() => subscribeMatchingUpdates(update => {
    if (update.provider === provider) setRevision(value => value + 1)
  }), [provider])
  useEffect(() => {
    let active = true
    const current = () => active && useProviderStore.getState().provider === provider && provider?.playbackSession === session && provider?.cacheScope === scope
    if (provider?.matchingResolve && key !== "[]") void associateMusicItems(JSON.parse(key), current)
      .then(matches => { if (current()) setValue({ identity, matches }) }).catch(() => {})
    return () => { active = false }
  }, [identity, revision])
  return value?.identity === identity ? value.matches : undefined
}
