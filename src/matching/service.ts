import { createMatchingBatch } from "./batch"
import { useProviderStore } from "../stores/providerStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import type { MatchingSource, MatchingResolution } from "./resolverTypes"

let owner: { provider: ReturnType<typeof useProviderStore.getState>["provider"]; session: unknown; scope: unknown; account: string | null; revision: number } | undefined
let resolver: ReturnType<typeof createMatchingBatch> | undefined
/** One index service shared by navigation, catalogs, queues and playlist matching.
 * Source IDs remain untouched; only an explicit verified target ID can be used. */
export function resolveIndexedMusic(source: MatchingSource, force = false): Promise<MatchingResolution | null> {
  const provider = useProviderStore.getState().provider
  if (!provider?.matchingResolve) return Promise.resolve(null)
  const youtube = useYoutubeMusicDiscoveryStore.getState()
  const session = provider.playbackSession, scope = provider.cacheScope
  if (!owner || owner.provider !== provider || owner.session !== session || owner.scope !== scope || owner.account !== youtube.accountId || owner.revision !== youtube.revision) {
    const identity = owner = { provider, session, scope, account: youtube.accountId, revision: youtube.revision }
    const current = () => owner === identity && provider === useProviderStore.getState().provider && provider.playbackSession === session && provider.cacheScope === scope && useYoutubeMusicDiscoveryStore.getState().accountId === youtube.accountId && useYoutubeMusicDiscoveryStore.getState().revision === youtube.revision
    const sourceOwner = youtube.accountId ?? "public-ytmusic"
    resolver = createMatchingBatch({ current,
      lookup: (sources, force) => provider.matchingResolve!(sourceOwner, sources, force),
      fallback: !provider.isOffline && provider.matchingFallback ? source => provider.matchingFallback!(sourceOwner, source) : undefined,
    })
  }
  return resolver!(source, force)
}

export async function reverseIndexedMusic(kind: "artist" | "album" | "track", id: string): Promise<MatchingSource[]> {
  const provider = useProviderStore.getState().provider
  if (!provider?.matchingReverse || !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) return []
  const youtube = useYoutubeMusicDiscoveryStore.getState(), session = provider.playbackSession, scope = provider.cacheScope
  const found = await provider.matchingReverse(youtube.accountId ?? "public-ytmusic", kind, Number(id))
  if (useProviderStore.getState().provider !== provider || provider.playbackSession !== session || provider.cacheScope !== scope ||
    useYoutubeMusicDiscoveryStore.getState().revision !== youtube.revision || useYoutubeMusicDiscoveryStore.getState().accountId !== youtube.accountId)
    throw Error("Music matching owner changed.")
  return found
}
