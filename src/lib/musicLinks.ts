import { useProviderStore } from "../stores/providerStore"
import { browseYoutubeMusic, useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import { createMusicLinkResolver } from "./musicLinkResolver"
import { trackEntity } from "./musicEntity"
import { youtubeMusicSongMetadata } from "../backends/ytmusic/metadata"
import type { MusicEntityRef } from "./musicEntity"
import type { ContextAction } from "../stores/contextMenuStore"
import { useNotificationCenterStore } from "../stores/notificationCenterStore"
export { musicEntityHref, trackEntity, albumArtistEntity, type MusicEntityRef } from "./musicEntity"

let owner: { provider: ReturnType<typeof useProviderStore.getState>["provider"]; session: unknown; scope: unknown; revision: number; connected: boolean } | null = null
let resolve: ReturnType<typeof createMusicLinkResolver> | null = null
export function resolveMusicEntity(ref: MusicEntityRef) {
  const provider = useProviderStore.getState().provider
  const session = provider?.playbackSession, scope = provider?.cacheScope
  const connection = useYoutubeMusicDiscoveryStore.getState()
  if (!owner || owner.provider !== provider || owner.session !== session || owner.scope !== scope ||
    owner.revision !== connection.revision || owner.connected !== connection.connected) {
    const identity = { provider, session, scope, revision: connection.revision, connected: connection.connected }
    owner = identity
    resolve = createMusicLinkResolver({
      hydrate: async ref => {
        if (!ref.trackId) return null
        const track = ref.trackId.startsWith("ytmusic:") ? await youtubeMusicSongMetadata(ref.trackId) : await provider?.getTrack(ref.trackId)
        return track ? trackEntity(track, "album") : null
      },
      current: () => owner === identity && useProviderStore.getState().provider === provider && provider?.playbackSession === session &&
        provider?.cacheScope === scope && useYoutubeMusicDiscoveryStore.getState().revision === connection.revision &&
        useYoutubeMusicDiscoveryStore.getState().connected === connection.connected,
      searchPlex: async ref => !provider || provider.isOffline ? [] : (await provider.search(ref.name, ref.kind)).flatMap(item =>
        item.type === ref.kind ? [{ id: item.id, name: item.title,
          artist: item.type === "album" ? item.artistName : undefined, year: item.type === "album" ? item.year : undefined }] : []),
      searchYoutube: async ref => {
        if (!connection.connected) return []
        const page = await browseYoutubeMusic({ browseId: ref.kind === "artist" ? "hibiki_artist_search" : "hibiki_search",
          params: ref.kind === "album" ? `${ref.artist ?? ""} ${ref.name}` : ref.name })
        return page.items.filter(item => item.kind === ref.kind).map(item => ({
          id: `ytmusic:${item.id}`, name: item.title, artist: item.artist, year: item.year,
        }))
      },
    })
  }
  return resolve!(ref)
}

export function captureMusicLinkOwner() {
  const provider = useProviderStore.getState().provider
  const session = provider?.playbackSession, scope = provider?.cacheScope
  const connection = useYoutubeMusicDiscoveryStore.getState()
  return () => useProviderStore.getState().provider === provider && provider?.playbackSession === session &&
    provider?.cacheScope === scope && useYoutubeMusicDiscoveryStore.getState().revision === connection.revision &&
    useYoutubeMusicDiscoveryStore.getState().connected === connection.connected
}

let navigation = 0
export const beginMusicLinkNavigation = () => ++navigation
export const isMusicLinkNavigation = (request: number) => request === navigation

export async function openMusicEntity(ref: MusicEntityRef | null, navigate: (href: string) => void) {
  if (!ref) return
  const request = beginMusicLinkNavigation(), owns = captureMusicLinkOwner(), location = window.location.href
  const current = () => owns() && isMusicLinkNavigation(request) && window.location.href === location
  try {
    const href = await resolveMusicEntity(ref)
    if (!current()) return
    if (!href) throw Error(`No matching ${ref.kind} was found. Try again after refreshing the page.`)
    navigate(href)
  } catch (error) {
    if (current()) useNotificationCenterStore.getState().notify({ id: `music.link.${ref.kind}`, title: `Could not open ${ref.kind}`,
      message: error instanceof Error ? error.message : "Please try again.", severity: "error" })
  }
}
export const musicEntityActions = (refs: (MusicEntityRef | null)[], navigate: (href: string) => void): ContextAction[] =>
  refs.filter((ref): ref is MusicEntityRef => !!ref).map(ref => ({ label: `Go to ${ref.kind}`, icon: ref.kind, section: "navigation" as const, run: () => openMusicEntity(ref, navigate) }))
