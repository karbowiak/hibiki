import { useEffect, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useLocation } from "wouter"
import { useLibraryStore, useConnectionStore, buildPlexImageUrl } from "../../stores"
import { prefetchArtist, prefetchAlbum } from "../../stores/metadataCache"
import type { PlexMedia, Playlist } from "../../types/plex"
import { searchLibrary } from "../../lib/plex"
import { ScrollRow } from "../ScrollRow"
import { MediaCard } from "../MediaCard"
import { selectMix } from "./Mix"

/** Strip common mix suffixes to get the artist name: "Ado Mix" → "Ado" */
export function mixTitleToArtistName(title: string): string {
  return title.replace(/\s+(Mix|Radio|Station|Mix Radio)$/i, "").trim()
}

/**
 * Module-level cache of mix title → artist thumb URL.
 * Survives component unmount/remount so images don't flash grey on navigation.
 * Shared with StationsPage so the two pages don't duplicate searches.
 * The actual image bytes are cached separately by the pleximg:// Tauri handler.
 */
export const mixThumbCache = new Map<string, string>()

function getItemYear(item: PlexMedia): number {
  if (item.type === "album") return item.year
  if (item.type === "track") return item.year
  return 0
}

function getMediaInfo(item: PlexMedia, baseUrl: string, token: string, opts?: { showYear?: boolean }) {
  switch (item.type) {
    case "album":
      return {
        title: item.title,
        desc: opts?.showYear && item.year > 0
          ? `${item.parent_title} · ${item.year}`
          : item.parent_title,
        thumb: item.thumb ? buildPlexImageUrl(baseUrl, token, item.thumb) : null,
        isArtist: false,
        href: `/album/${item.rating_key}`,
        ratingKey: item.rating_key,
        itemType: "album" as const,
      }
    case "artist":
      return {
        title: item.title,
        desc: "Artist",
        thumb: item.thumb ? buildPlexImageUrl(baseUrl, token, item.thumb) : null,
        isArtist: true,
        href: `/artist/${item.rating_key}`,
        ratingKey: item.rating_key,
        itemType: "artist" as const,
      }
    case "track":
      return {
        title: item.title,
        desc: opts?.showYear && item.year > 0
          ? `${item.grandparent_title} · ${item.year}`
          : item.grandparent_title,
        thumb: item.thumb ? buildPlexImageUrl(baseUrl, token, item.thumb) : null,
        isArtist: false,
        href: null,
        ratingKey: item.rating_key,
        itemType: "track" as const,
      }
    case "playlist":
      return {
        title: item.title,
        desc: "Playlist",
        // Prefer thumb (artist image on mixes) over composite (collage)
        thumb: item.thumb
          ? buildPlexImageUrl(baseUrl, token, item.thumb)
          : item.composite
            ? buildPlexImageUrl(baseUrl, token, item.composite)
            : null,
        isArtist: false,
        href: `/playlist/${item.rating_key}`,
        ratingKey: item.rating_key,
        itemType: "playlist" as const,
      }
    default:
      return null
  }
}

export function Home() {
  // Granular selector: only re-render when recentlyAdded or hubs actually change.
  // Changes to playlistItemsCache (from background prefetch) do NOT trigger re-renders here.
  const { recentlyAdded, hubs } = useLibraryStore(useShallow(s => ({
    recentlyAdded: s.recentlyAdded,
    hubs: s.hubs,
  })))
  const { baseUrl, token, isConnected, isLoading: isConnecting, musicSectionId } = useConnectionStore()
  const [, navigate] = useLocation()

  // Seed from module-level cache so images are available immediately on remount.
  const [mixThumbs, setMixThumbs] = useState<Record<string, string>>(
    () => Object.fromEntries(mixThumbCache)
  )

  const hasRealData = recentlyAdded.length > 0 || hubs.length > 0

  const sectionId = musicSectionId ?? 0

  const mixesHubs = hubs.filter(h => h.hub_identifier.startsWith("music.mixes"))
  const mixesItems = mixesHubs.flatMap(h => h.metadata)
  const mixesTitle = mixesHubs[0]?.title ?? "Mixes for You"

  // For each mix, search the library for the artist named in the title and
  // cache their thumbnail. Already-cached titles are skipped.
  useEffect(() => {
    if (!isConnected || mixesItems.length === 0 || sectionId === 0) return
    const controller = new AbortController()

    const run = async () => {
      const updates: Record<string, string> = {}
      for (const item of mixesItems) {
        if (controller.signal.aborted) break
        if (item.type !== "playlist") continue
        if (mixThumbCache.has(item.title)) continue  // already resolved
        const artistName = mixTitleToArtistName(item.title)
        if (!artistName) continue
        try {
          const results = await searchLibrary(sectionId, artistName, "artist")
          const artist = results.find(
            r => r.type === "artist" && r.title.toLowerCase() === artistName.toLowerCase()
          ) ?? results.find(r => r.type === "artist")
          if (artist && artist.type === "artist" && artist.thumb) {
            const url = buildPlexImageUrl(baseUrl, token, artist.thumb)
            mixThumbCache.set(item.title, url)
            updates[item.title] = url
          }
        } catch {
          // search failure for one mix shouldn't abort the rest
        }
      }
      if (!controller.signal.aborted && Object.keys(updates).length > 0) {
        setMixThumbs(prev => ({ ...prev, ...updates }))
      }
    }

    void run()
    return () => controller.abort()
  }, [isConnected, sectionId, mixesItems.length])

  if (!hasRealData) {
    const message = isConnecting
      ? "Connecting to your Plex library…"
      : isConnected
        ? "Loading your library…"
        : "Not connected to Plex."
    return (
      <div className="space-y-8">
        <div className="text-gray-400 text-sm">{message}</div>
      </div>
    )
  }

  function makePrefetch(info: ReturnType<typeof getMediaInfo>) {
    if (!info) return undefined
    if (info.itemType === "artist") return () => prefetchArtist(info.ratingKey, sectionId)
    if (info.itemType === "album") return () => prefetchAlbum(info.ratingKey)
    return undefined
  }

  return (
    <div className="space-y-8 pb-8">
      {mixesItems.length > 0 && (
        <ScrollRow title={mixesTitle} restoreKey="home-mixes">
          {mixesItems.map((item, idx) => {
            if (item.type !== "playlist") return null
            const thumb = mixThumbs[item.title]
              ?? (item.thumb ? buildPlexImageUrl(baseUrl, token, item.thumb) : null)
              ?? (item.composite ? buildPlexImageUrl(baseUrl, token, item.composite) : null)
            return (
              <MediaCard
                key={idx}
                title={item.title}
                desc="Mix for You"
                thumb={thumb}
                isArtist={false}
                onClick={() => {
                  selectMix(item as Playlist & { type: "playlist" })
                  navigate("/mix")
                }}
                scrollItem
                large
              />
            )
          })}
        </ScrollRow>
      )}

      {recentlyAdded.length > 0 && (
        <ScrollRow title="Recently Added" restoreKey="home-recently-added">
          {recentlyAdded.slice(0, 30).map((item, idx) => {
            const info = getMediaInfo(item, baseUrl, token)
            if (!info) return null
            return (
              <MediaCard
                key={idx}
                title={info.title}
                desc={info.desc}
                thumb={info.thumb}
                isArtist={info.isArtist}
                href={info.href ?? undefined}
                prefetch={makePrefetch(info)}
                scrollItem
              />
            )
          })}
        </ScrollRow>
      )}

      {hubs.map(hub => {
        if (hub.metadata.length === 0) return null
        // Skip mixes hubs — already rendered as the pinned top section
        if (hub.hub_identifier.startsWith("music.mixes")) return null
        const isAnniversary = hub.hub_identifier.includes("anniversary")
        // "On This Day" — sort oldest → newest and show the release year.
        const items = isAnniversary
          ? [...hub.metadata].sort((a, b) => getItemYear(a) - getItemYear(b))
          : hub.metadata
        return (
          <ScrollRow key={hub.hub_identifier} title={hub.title} restoreKey={`home-hub-${hub.hub_identifier}`}>
            {items.slice(0, 30).map((item, idx) => {
              const info = getMediaInfo(item, baseUrl, token, { showYear: isAnniversary })
              if (!info) return null
              return (
                <MediaCard
                  key={idx}
                  title={info.title}
                  desc={info.desc}
                  thumb={info.thumb}
                  isArtist={info.isArtist}
                  href={info.href ?? undefined}
                  prefetch={makePrefetch(info)}
                  scrollItem
                />
              )
            })}
          </ScrollRow>
        )
      })}
    </div>
  )
}
