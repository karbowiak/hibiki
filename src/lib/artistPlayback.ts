import type { MusicProvider } from "../providers/types"
import type { MusicTrack } from "../types/music"
import type { PagedTrackSource } from "./pagedPlayback"
import { useProviderStore } from "../stores/providerStore"
import { sameRecording } from "./musicMatching"
import { useYoutubeMusicDiscoveryStore, youtubeMusicCollectionSource, youtubeMusicItemTrack, type YoutubeMusicBrowsePage } from "../backends/ytmusic/discovery"

/** Resolve on selection, then page a mixed artist queue without crawling YTM albums. */
export function artistPlaybackSource(provider: MusicProvider | null, plexId: string | null,
  localPreview: MusicTrack[], youtube: YoutubeMusicBrowsePage): PagedTrackSource {
  const revision = useYoutubeMusicDiscoveryStore.getState().revision
  const session = provider?.playbackSession, scope = provider?.cacheScope
  const owns = () => provider === useProviderStore.getState().provider && provider?.playbackSession === session &&
    provider?.cacheScope === scope && useYoutubeMusicDiscoveryStore.getState().connected && useYoutubeMusicDiscoveryStore.getState().revision === revision
  const key = `artist:${plexId ?? ""}:${youtube.artist?.id ?? ""}`
  return { key, prepare: async () => {
    if (!owns()) throw Error("Music connection changed.")
    const local = plexId && provider?.getArtistTracks ? await provider.getArtistTracks(plexId) : localPreview
    if (!owns()) throw Error("Music connection changed.")
    const seen = new Set<string>()
    const destination = youtube.artist?.songs ?? youtube.artist?.shuffle
    const remote = destination ? youtubeMusicCollectionSource(destination) : null
    let pending: MusicTrack[] = youtube.items.filter(item => item.kind === "song").map(youtubeMusicItemTrack)
    let remoteOffset = 0, localOffset = 0, remoteDone = !remote
    const buffer: MusicTrack[] = []
    let serial = Promise.resolve()
    const nextRemote = async (): Promise<MusicTrack | null> => {
      for (;;) {
        while (pending.length) {
          const track = pending.shift()!
          if (seen.has(track.id) || local.some(known => sameRecording(known, track))) continue
          seen.add(track.id)
          return track
        }
        if (remoteDone || !remote) return null
        const page = await remote.loadPage(remoteOffset, 25)
        if (!owns()) throw Error("Music connection changed.")
        remoteOffset += page.items.length
        remoteDone = !page.items.length || remoteOffset >= page.total
        pending = page.items
      }
    }
    return { key, pageSize: 50, loadPage: (offset, limit) => {
      const load = async () => {
        if (!owns()) throw Error("Music connection changed.")
        while (buffer.length < offset + limit) {
          const left = local[localOffset++]
          if (left) buffer.push(left)
          const right = await nextRemote()
          if (right) buffer.push(right)
          if (!left && !right) break
        }
        const more = localOffset < local.length || pending.length > 0 || !remoteDone
        return { items: buffer.slice(offset, offset + limit), total: buffer.length + (more ? 1 : 0), offset }
      }
      const result = serial.then(load)
      serial = result.then(() => {}, () => {})
      return result
    } }
  }, loadPage: async () => ({ items: [], total: 0 }) }
}
