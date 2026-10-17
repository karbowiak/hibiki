import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useProviderStore } from "../stores/providerStore"
import { useUIStore } from "../stores/uiStore"
import { useArtistPage } from "./useMetadataPage"
import { browseYoutubeMusic, subscribeYoutubeMusicCatalog, useYoutubeMusicDiscovery, type YoutubeMusicBrowsePage } from "../backends/ytmusic/discovery"
import { buildExternalImageUrl } from "../lib/imageUrl"
import { ARTIST_NAME_THRESHOLD, artistNameSimilarity, plexArtistEvidence, selectArtistCandidate, youtubeArtistEvidence } from "../lib/artistMatching"
import { loadArtistPage } from "../stores/metadataCache"
import type { MusicArtist } from "../types/music"

// Bound catalog lookups without selecting from a truncated set of candidates.
const MAX_ARTIST_CANDIDATES = 6

export function useArtistCatalog(routeId: string) {
  const { provider, session, scope } = useProviderStore(useShallow(state => ({
    provider: state.provider, session: state.provider?.playbackSession, scope: state.provider?.cacheScope,
  })))
  const connection = useYoutubeMusicDiscovery()
  const refresh = useUIStore(state => state.pageRefreshKey)
  const [attempt, setAttempt] = useState(0)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const isYoutubeRoute = routeId.startsWith("ytmusic:")
  const identity = useMemo(() => ({}), [routeId, provider, session, scope, connection.revision, refresh, attempt])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const [value, setValue] = useState<{ identity: object; page: YoutubeMusicBrowsePage | null; plexId: string | null; loading: boolean; error: boolean } | null>(null)
  const state = value?.identity === identity ? value : null
  const plexId = isYoutubeRoute ? state?.plexId ?? null : routeId
  const plex = useArtistPage(plexId)
  const entry = plex.entry?.artist.id === plexId ? plex.entry : undefined
  const name = !isYoutubeRoute ? entry?.artist.title ?? null : null
  const evidence = useMemo(() => !isYoutubeRoute && entry ? plexArtistEvidence(entry) : null,
    [isYoutubeRoute, entry?.albums, entry?.singles, entry?.popularTracks])
  const previousRequest = useRef({ routeId, refresh, attempt })

  useEffect(() => subscribeYoutubeMusicCatalog(update => {
    if ((update.browseId === "hibiki_artist_search" && update.params === name) ||
      (update.browseId.startsWith("UC") && !update.params && !update.continuation)) setCatalogRevision(value => value + 1)
  }), [name])

  useEffect(() => {
    if (!connection.connected || (!isYoutubeRoute && !name)) return
    let active = true
    const owns = () => active && currentIdentity.current === identity &&
      useProviderStore.getState().provider === provider && provider?.playbackSession === session && provider?.cacheScope === scope
    const previous = previousRequest.current
    const force = previous.routeId === routeId && (previous.attempt !== attempt || previous.refresh !== refresh)
    previousRequest.current = { routeId, refresh, attempt }
    setValue(previous => previous?.identity === identity ? { ...previous, loading: true, error: false }
      : { identity, page: null, plexId: null, loading: true, error: false })
    void (async () => {
      let page: YoutubeMusicBrowsePage | null = null
      if (isYoutubeRoute) {
        page = await browseYoutubeMusic({ browseId: routeId.slice(8) }, null, force)
      } else if (name && evidence) {
        const results = await browseYoutubeMusic({ browseId: "hibiki_artist_search", params: name }, null, force)
        if (!owns()) return
        const matches = [...new Map(results.items.filter(item => item.kind === "artist" &&
          artistNameSimilarity(name, item.title) >= ARTIST_NAME_THRESHOLD).map(item => [item.id, item])).values()]
        if (matches.length && matches.length <= MAX_ARTIST_CANDIDATES) {
          const pages = await Promise.all(matches.map(item => browseYoutubeMusic({ browseId: item.id }, null, force)))
          if (!owns()) return
          page = selectArtistCandidate(name, evidence, pages.filter(candidate => candidate.artist).map(candidate => ({
            value: candidate, name: candidate.artist!.name, catalog: youtubeArtistEvidence(candidate),
            canonicalId: candidate.artist!.channelId,
          })))
        }
      }
      if (!owns()) return
      if (!page?.artist) {
        if (owns()) setValue({ identity, page: null, plexId: null, loading: false, error: false })
        return
      }
      setValue(previous => ({ identity, page, plexId: isYoutubeRoute && previous?.identity === identity ? previous.plexId : null, loading: false, error: false }))
      if (isYoutubeRoute && provider) {
        // A failed Plex lookup leaves the fully usable YTM artist page intact.
        try {
          const artistName = page.artist.name
          const results = await provider.search(artistName, "artist")
          if (!owns()) return
          const matches = [...new Map(results.filter(item => item.type === "artist" &&
            artistNameSimilarity(artistName, item.title) >= ARTIST_NAME_THRESHOLD).map(item => [item.id, item])).values()]
          let matchedId = matches.length === 1 ? matches[0].id : null
          if (matches.length > 1 && matches.length <= MAX_ARTIST_CANDIDATES) {
            const catalogs = await Promise.all(matches.map(item => loadArtistPage(item.id)))
            if (!owns()) return
            matchedId = selectArtistCandidate(artistName, youtubeArtistEvidence(page), catalogs.map(candidate => ({
              value: candidate.artist.id, name: candidate.artist.title, catalog: plexArtistEvidence(candidate),
            })))
          }
          if (owns()) setValue({ identity, page, plexId: matchedId, loading: false, error: false })
        } catch { /* Keep the YTM page available. */ }
      }
    })().catch(() => {
      if (owns()) setValue(previous => previous?.identity === identity ? { ...previous, loading: false, error: true }
        : { identity, page: null, plexId: null, loading: false, error: true })
    })
    return () => { active = false }
  }, [identity, routeId, isYoutubeRoute, name, evidence, connection.connected, provider, session, scope, attempt, refresh, catalogRevision])

  const youtube = connection.connected ? state?.page ?? null : null
  const remote = youtube?.artist
  const artist: MusicArtist | null = entry?.artist ?? (remote ? {
    id: `ytmusic:${remote.id}`, title: remote.name, thumbUrl: buildExternalImageUrl(remote.thumbnail),
    artUrl: buildExternalImageUrl(remote.background), summary: remote.description, userRating: null,
    addedAt: null, guid: null, providerKey: "ytmusic",
  } : null)
  const retry = useCallback(() => { plex.retry(); setAttempt(value => value + 1) }, [plex.retry])
  return {
    artist, entry, plexId: entry?.artist.id ?? null, youtube,
    youtubeLoading: connection.connected && !!state?.loading,
    youtubeError: connection.connected && !!state?.error,
    connected: connection.connected,
    isLoading: isYoutubeRoute ? connection.connected && !youtube && (!state || state.loading) : plex.isLoading,
    error: isYoutubeRoute ? state?.error ? "Could not load this YouTube Music artist." : null : plex.error,
    retry,
    href: isYoutubeRoute ? `/ytmusic/${encodeURIComponent(routeId.slice(8))}` : `/artist/${routeId}`,
  }
}
