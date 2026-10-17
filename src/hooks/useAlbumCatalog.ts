import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useAlbumPage } from "./useMetadataPage"
import { useProviderStore } from "../stores/providerStore"
import { useUIStore } from "../stores/uiStore"
import { browseYoutubeMusic, subscribeYoutubeMusicCatalog, useYoutubeMusicDiscovery, youtubeMusicItemTrack, type YoutubeMusicBrowsePage } from "../backends/ytmusic/discovery"
import { artistNameSimilarity, ARTIST_NAME_THRESHOLD } from "../lib/artistMatching"
import { releaseNameKey, sameRecording, supplementAlbumTracks } from "../lib/musicMatching"
import type { MusicTrack } from "../types/music"

/** Only the selected album is read; opening it never scans an artist's catalog. */
export function useAlbumCatalog(albumId: string) {
  const plex = useAlbumPage(albumId)
  const entry = plex.entry?.album.id === albumId ? plex.entry : undefined
  const album = entry?.album
  const { provider, session, scope } = useProviderStore(useShallow(state => ({
    provider: state.provider, session: state.provider?.playbackSession, scope: state.provider?.cacheScope,
  })))
  const youtube = useYoutubeMusicDiscovery()
  const refresh = useUIStore(state => state.pageRefreshKey)
  const [attempt, setAttempt] = useState(0)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const identity = useMemo(() => ({}), [albumId, provider, session, scope, youtube.revision, refresh, attempt])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const query = album ? `${album.artistName} ${album.title}` : null
  const [saved, setSaved] = useState<{ identity: object; page: YoutubeMusicBrowsePage | null; tracks: MusicTrack[]; loading: boolean; error: boolean } | null>(null)
  const state = saved?.identity === identity ? saved : null
  const previous = useRef({ albumId, refresh, attempt })

  useEffect(() => subscribeYoutubeMusicCatalog(update => {
    if ((update.browseId === "hibiki_search" && update.params === query) || update.browseId.startsWith("MPRE"))
      setCatalogRevision(value => value + 1)
  }), [query])

  useEffect(() => {
    if (!youtube.connected || provider?.isOffline || !album || !query) return
    let active = true
    const owns = () => active && currentIdentity.current === identity && useProviderStore.getState().provider === provider &&
      provider?.playbackSession === session && provider?.cacheScope === scope
    const force = previous.current.albumId === albumId && (previous.current.refresh !== refresh || previous.current.attempt !== attempt)
    previous.current = { albumId, refresh, attempt }
    setSaved(value => value?.identity === identity ? { ...value, loading: true, error: false }
      : { identity, page: null, tracks: [], loading: true, error: false })
    void (async () => {
      const search = await browseYoutubeMusic({ browseId: "hibiki_search", params: query }, null, force)
      if (!owns()) return
      const candidates = [...new Map(search.items.filter(item => item.kind === "album" && releaseNameKey(item.title) === releaseNameKey(album.title) &&
        artistNameSimilarity(item.artist, album.artistName) >= ARTIST_NAME_THRESHOLD && (!item.year || !album.year || item.year === album.year))
        .map(item => [item.id, item])).values()]
      const pages = candidates.length <= 4 ? await Promise.all(candidates.map(async item => {
        const page = await browseYoutubeMusic({ browseId: item.id }, null, force)
        if (!owns()) return null
        if (releaseNameKey(page.title) !== releaseNameKey(album.title)) return null
        const items = [...page.items], visited = new Set<string>()
        let cursor = page.continuation
        for (let count = 0; cursor && count < 20 && owns(); count++) {
          if (visited.has(cursor)) break
          visited.add(cursor)
          const next = await browseYoutubeMusic({ browseId: item.id }, cursor, force)
          if (!owns()) return null
          items.push(...next.items)
          cursor = next.continuation
        }
        const tracks = [...new Map(items.filter(item => item.kind === "song").map(item => [item.id, item])).values()]
          .map((item, index) => ({ ...youtubeMusicItemTrack(item), artistName: item.artist || album.artistName,
            artistId: artistNameSimilarity(item.artist || album.artistName, album.artistName) >= ARTIST_NAME_THRESHOLD ? album.artistId : item.artistId ? `ytmusic:${item.artistId}` : null,
            albumId: album.id, albumName: album.title, trackNumber: item.trackNumber || index + 1 }))
        if (!tracks.length || !tracks.some(track => artistNameSimilarity(track.artistName, album.artistName) >= ARTIST_NAME_THRESHOLD)) return null
        return { page: { ...page, items }, tracks, overlap: (entry?.tracks ?? []).filter(local => tracks.some(remote => sameRecording(local, remote))).length }
      })) : []
      if (!owns()) return
      const ranked = pages.filter(Boolean).sort((a, b) => b!.overlap - a!.overlap)
      const best = ranked[0]
      const aliases = best && ranked.every(candidate => candidate!.tracks.map(track => track.id).join(",") === best.tracks.map(track => track.id).join(","))
      const match = best && (ranked.length === 1 || best.overlap > ranked[1]!.overlap || aliases) ? best : null
      setSaved({ identity, page: match?.page ?? null, tracks: match?.tracks ?? [], loading: false, error: false })
    })().catch(() => {
      if (owns()) setSaved(value => value?.identity === identity ? { ...value, loading: false, error: true }
        : { identity, page: null, tracks: [], loading: false, error: true })
    })
    return () => { active = false }
  }, [identity, albumId, album, entry?.tracks, query, youtube.connected, provider, session, scope, refresh, attempt, catalogRevision])

  const tracks = useMemo(() => supplementAlbumTracks(entry?.tracks ?? [], youtube.connected && !provider?.isOffline ? state?.tracks ?? [] : []),
    [entry?.tracks, youtube.connected, provider?.isOffline, state?.tracks])
  return { ...plex, entry, tracks, youtube: youtube.connected ? state?.page ?? null : null,
    youtubeLoading: !!state?.loading, youtubeError: !!state?.error,
    retry: useCallback(() => { plex.retry(); setAttempt(value => value + 1) }, [plex.retry]) }
}
