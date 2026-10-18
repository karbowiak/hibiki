import { useMemo, useRef, useState, type ReactNode } from "react"
import { ScrollRow } from "../ScrollRow"
import { DiscoveryMore } from "./DiscoveryMore"
import { browseYoutubeMusic, observeYoutubeMusicPages, useYoutubeMusicDiscoveryStore, type YoutubeMusicBrowsePage, type YoutubeMusicHub } from "../../backends/ytmusic/discovery"
import { useDiscoveryFeed } from "../../hooks/useDiscoveryFeed"
import { useUIStore } from "../../stores/uiStore"
import { mergeDiscoveryItems, youtubeDiscoveryItems, type DiscoveryItem } from "../../lib/discovery"
import { useMusicAssociations } from "../../hooks/useMusicAssociations"
import { youtubeMusicItemMusic } from "../../backends/ytmusic/discovery"

/** Artist shelves expand on demand and retain the provider's continuation. */
export function ArtistCatalogSection({ title, restoreKey, plex, youtube, renderItem, ownedReleases = [], artistName }: {
  title: string
  restoreKey: string
  plex: DiscoveryItem[]
  youtube?: YoutubeMusicHub
  ownedReleases?: DiscoveryItem[]
  artistName: string
  renderItem: (entry: DiscoveryItem) => ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const revision = useYoutubeMusicDiscoveryStore(state => state.revision)
  const refresh = useUIStore(state => state.pageRefreshKey)
  const openedAtRefresh = useRef(refresh)
  const destination = youtube?.destination
  const slice = (page: YoutubeMusicBrowsePage) => ({
    items: page.items.map(item => !item.artist && ["albums", "singles", "songs", "live"].includes(youtube?.category ?? "")
      ? { ...item, artist: artistName } : item), next: page.continuation ?? undefined,
  })
  const feed = useDiscoveryFeed(revision, expanded && destination ? JSON.stringify([restoreKey, destination, refresh]) : null,
    youtube?.items ?? [], item => item.id, destination ? async cursor => {
      const page = await browseYoutubeMusic(destination, typeof cursor === "string" ? cursor : null,
        cursor === null && refresh !== openedAtRefresh.current, youtube?.category === "live")
      return slice(page)
    } : null, destination ? receive => observeYoutubeMusicPages(destination,
      (cursor, page) => receive(cursor, slice(page)), youtube?.category === "live") : undefined)
  const remote = useMemo(() => {
    const keepPreview = !expanded || !feed.initialized || youtube?.category === "live"
    const preview = new Map((keepPreview ? youtube?.items ?? [] : []).map(item => [item.id, item]))
    if (expanded && feed.initialized) feed.items.forEach(item => preview.set(item.id, item))
    return [...preview.values()].filter(item => !["albums", "singles"].includes(youtube?.category ?? "") || item.kind === "album")
  }, [youtube, feed.items, feed.initialized, expanded])
  const associations = useMusicAssociations(remote.map(youtubeMusicItemMusic))
  const entries = useMemo(() => {
    const missing = mergeDiscoveryItems(ownedReleases, youtubeDiscoveryItems(remote), associations).filter(item => item.source === "ytmusic")
    const merged = mergeDiscoveryItems(plex, missing, associations)
    if (["albums", "singles"].includes(youtube?.category ?? "")) {
      const year = (entry: DiscoveryItem) => entry.source === "ytmusic" ? entry.item.year ?? 0 : "year" in entry.item ? entry.item.year : 0
      merged.sort((a, b) => year(b) - year(a))
    }
    return merged
  }, [plex, youtube, remote, ownedReleases, associations])
  if (!entries.length && !destination) return null
  return <div>
    <ScrollRow title={title} restoreKey={restoreKey} onExpandedChange={destination ? setExpanded : undefined}>
      {entries.map(renderItem)}
    </ScrollRow>
    {!entries.length && !expanded && <p className="mt-3 text-sm text-(--text-secondary)">Expand to browse more releases.</p>}
    {expanded && destination && <DiscoveryMore more={feed.more} loading={feed.loading} error={feed.error} load={() => void feed.loadMore()} />}
  </div>
}
