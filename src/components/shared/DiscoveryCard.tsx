import { MusicSourceBadge } from "./MusicSource"
import { MediaCard } from "../MediaCard"
import type { DiscoveryItem } from "../../lib/discovery"
import { getMediaInfo, makeDragPayload } from "../../lib/mediaCardInfo"
import { makeOnPlay } from "../../lib/mediaPlay"
import { usePlayerStore } from "../../stores/playerStore"
import { useProviderStore } from "../../stores/providerStore"
import { prefetchAlbum, prefetchArtist } from "../../stores/metadataCache"
import { buildExternalImageUrl } from "../../lib/imageUrl"
import { youtubeMusicCollectionSource, youtubeMusicItemHref, youtubeMusicItemTrack, useYoutubeMusicDiscoveryStore } from "../../backends/ytmusic/discovery"
import { useYoutubeMusicLikesStore } from "../../backends/ytmusic/likes"
import { useLocation } from "wouter"
import { youtubeMusicContext } from "../../backends/ytmusic/contextActions"

export function DiscoveryCard({ entry, scrollItem, large, showYear, mix }: { entry: DiscoveryItem; scrollItem?: boolean; large?: boolean; showYear?: boolean; mix?: boolean }) {
  const [, navigate] = useLocation()
  const provider = useProviderStore(state => state.provider)
  useYoutubeMusicLikesStore(state => entry.source === "ytmusic" && entry.item.kind === "song"
    ? state.entries[`ytmusic:${entry.item.id}`]?.liked : undefined)
  if (entry.source === "plex") {
    const item = entry.item
    const info = getMediaInfo(item, { showYear })
    if (!info) return null
    const player = usePlayerStore.getState()
    return <MediaCard contextItem={item} title={info.title} desc={info.desc} thumb={info.thumb} isArtist={info.isArtist}
      userRating={item.userRating} artistName={"artistName" in info ? info.artistName : null} albumName={"albumName" in info ? info.albumName : null}
      href={info.href ?? undefined} scrollItem={scrollItem} large={large} dragPayload={makeDragPayload(item)}
      artworkBadge={<MusicSourceBadge source="plex" />}
      prefetch={info.itemType === "album" ? () => prefetchAlbum(info.id) : info.itemType === "artist" ? () => prefetchArtist(info.id) : undefined}
      onPlay={makeOnPlay(item, { ...player, provider })} />
  }
  const item = entry.item
  const play = () => {
    if (!useYoutubeMusicDiscoveryStore.getState().connected) return
    const player = usePlayerStore.getState()
    if (item.kind === "song") void player.playTrack(youtubeMusicItemTrack(item), undefined, "YouTube Music")
    else void player.playPagedTracks(youtubeMusicCollectionSource({ browseId: item.id }), item.title, youtubeMusicItemHref(item))
  }
  return <MediaCard title={item.title} desc={[item.description || item.artist, showYear ? item.year : null, mix ? null : "YTM"].filter(Boolean).join(" · ") || "Mix for You"}
    thumb={item.thumbnail ? buildExternalImageUrl(item.thumbnail) : null} scrollItem={scrollItem} large={large}
    artworkBadge={<MusicSourceBadge source="ytmusic" />}
    isArtist={item.kind === "artist"}
    navigationEntity={item.kind === "artist" || item.kind === "album" ? { kind: item.kind, id: `ytmusic:${item.id}`, name: item.title, artist: item.artist, year: item.year } : undefined}
    descriptionEntity={(item.kind === "song" || item.kind === "album") && item.artist
      ? { kind: "artist", id: item.artistId ? `ytmusic:${item.artistId}` : null, name: item.artist } : null}
    href={item.kind === "song" ? undefined : youtubeMusicItemHref(item)} onClick={item.kind === "song" ? play : undefined}
    onPlay={play} contextActions={youtubeMusicContext(item, navigate).actions} />
}
