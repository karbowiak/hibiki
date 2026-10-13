import {
  useLayoutEffect,
  useMemo,
  useRef,
  useReducer,
  useCallback,
  useEffect,
  useState,
} from "react"
import { useStore } from "zustand"
import { useShallow } from "zustand/shallow"
import { useArtworkAppearanceStore } from "../stores/artworkAppearanceStore"
import { useLibraryStore } from "../stores/libraryStore"
import { useProviderStore } from "../stores/providerStore"
import {
  ambientArtworkController,
  type AmbientArtwork,
  type AmbientArtworkClaim,
  type AmbientHeroClaim,
} from "../stores/ambientArtworkStore"
import {
  collectAmbientCandidates,
  collectPlaylistAmbientCandidates,
  isCurrentPlaylistRoute,
  type AmbientCandidate,
} from "../lib/ambientArtwork"
import { useArtistArtwork, useAlbumArtwork } from "./useMediaImage"
import {
  applyArtworkRevision,
  artworkRevisionKey,
  useArtworkPreferenceStore,
} from "../stores/artworkPreferenceStore"
export function useAmbientArtworkClaim(
  owner: string,
  claim: AmbientArtworkClaim | null
) {
  const provider = useProviderStore((s) => s.provider),
    scope = useProviderStore((s) => s.provider?.cacheScope ?? undefined)
  const lease = useRef<ReturnType<
    typeof ambientArtworkController.acquire
  > | null>(null)
  useLayoutEffect(() => {
    const active = ambientArtworkController.acquire(owner, provider, scope)
    lease.current = active
    active.update(claim)
    return () => {
      active.release()
      if (lease.current === active) lease.current = null
    }
  }, [owner, provider, scope, claim?.route])
  useLayoutEffect(() => {
    lease.current?.update(claim)
  }, [claim])
}
export function useAmbientHeroClaim(
  owner: string,
  claim: AmbientHeroClaim | null
) {
  const provider = useProviderStore((s) => s.provider),
    scope = provider?.cacheScope ?? undefined
  const lease = useRef<ReturnType<
    typeof ambientArtworkController.acquireHero
  > | null>(null)
  useLayoutEffect(() => {
    const active = ambientArtworkController.acquireHero(owner, provider, scope)
    lease.current = active
    active.update(claim)
    return () => {
      active.release()
      if (lease.current === active) lease.current = null
    }
  }, [owner, provider, scope, claim?.route])
  useLayoutEffect(() => {
    lease.current?.update(claim)
  }, [claim])
}
export function useAmbientArtwork(route: string): {
  artwork: AmbientArtwork | null
  onFailure: (src: string) => void
  next: () => void
  canRotate: boolean
  playlistOwners?: readonly string[]
} {
  const provider = useProviderStore((s) => s.provider),
    scope = useProviderStore((s) => s.provider?.cacheScope ?? undefined)
  const library = useLibraryStore(
    useShallow((s) => ({
      likedArtists: s.likedArtists,
      likedAlbums: s.likedAlbums,
      latestReleases: s.latestReleases,
      recentlyAdded: s.recentlyAdded,
      hubs: s.hubs,
      likedTracks: s.likedTracks,
      playlists: s.playlists,
      currentPlaylistId: s.currentPlaylistId,
      currentPlaylistItems: s.currentPlaylistItems,
    }))
  )
  const playlistRoute = /^\/playlist(?:\/|$)/.test(route)
  const candidates = useMemo(() => {
    if (!scope) return []
    if (playlistRoute)
      return isCurrentPlaylistRoute(route, library.currentPlaylistId)
        ? collectPlaylistAmbientCandidates(
            library.currentPlaylistItems ?? [],
            scope,
            library.likedArtists ?? []
          )
        : []
    return collectAmbientCandidates(library, scope)
  }, [library, scope, route, playlistRoute])
  const visit = useMemo(
    () => ({
      route,
      provider,
      scope,
      seed: Math.random(),
      selected: null as AmbientCandidate | null,
      attempts: 0,
      excluded: new Set<string>(),
    }),
    [route, provider, scope]
  )
  const [, retry] = useReducer((value: number) => value + 1, 0)
  const activeVisit = useRef(visit)
  useLayoutEffect(() => {
    activeVisit.current = visit
  }, [visit])
  const failed = useStore(ambientArtworkController.store, (s) => s.failed)
  if (
    playlistRoute &&
    visit.selected &&
    !candidates.some((candidate) => candidate.key === visit.selected?.key)
  )
    visit.selected = null
  if (!visit.selected && visit.attempts < 5 && candidates.length) {
    const options = candidates.filter(
      (c) => !visit.excluded.has(c.key) && !failed.includes(c.src)
    )
    if (options.length) {
      visit.selected =
        options[Math.floor(visit.seed * options.length) % options.length]
      visit.attempts++
    }
  }
  const candidate =
    candidates.find((c) => c.key === visit.selected?.key) ??
    (playlistRoute ? null : visit.selected)
  const artist = useArtistArtwork(
    candidate?.kind === "artist" ? candidate.artist : null,
    candidate?.kind === "artist" ? candidate.src : null,
    candidate?.id,
    failed,
    false,
    playlistRoute ? "background" : "poster"
  )
  const album = useAlbumArtwork(
    candidate?.kind === "album" ? candidate.artist : null,
    candidate?.kind === "album" ? candidate.album : null,
    candidate?.kind === "album" ? candidate.src : null,
    candidate?.id,
    failed,
    false,
    playlistRoute ? "background" : "poster"
  )
  const revisions = useArtworkPreferenceStore((s) => s.revisions)
  const plainKey =
    scope && candidate ? artworkRevisionKey(scope, candidate.src) : null
  const plain = candidate
    ? applyArtworkRevision(
        candidate.src,
        plainKey ? revisions[plainKey] : undefined
      )
    : null
  const src =
    candidate?.kind === "artist"
      ? artist.url
      : candidate?.kind === "album"
        ? album.url
        : plain && !failed.includes(plain)
          ? plain
          : null
  const detail = useStore(ambientArtworkController.store, () =>
    ambientArtworkController.getWinner(route, provider, scope)
  )
  useLayoutEffect(() => {
    if (candidate && !src && !detail && visit.attempts < 5) {
      visit.excluded.add(candidate.key)
      visit.selected = null
      // Publish an owned retry tick without starting any requests.
      ambientArtworkController.fail(candidate.src, provider, scope)
      retry()
    }
  }, [candidate, src, detail, visit, failed, provider, scope])
  const align = useStore(ambientArtworkController.store, () =>
    ambientArtworkController.getHeroWinner(route, provider, scope)
  )
  const backgroundEnabled = useArtworkAppearanceStore(
    (s) => s.backgroundArtworkEnabled
  )
  const rotationEnabled = useArtworkAppearanceStore(
    (s) => s.backgroundRotationEnabled
  )
  const [visible, setVisible] = useState(
    () =>
      typeof document !== "undefined" && document.visibilityState === "visible"
  )
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])
  const options = candidates.filter(
    (c) => !visit.excluded.has(c.key) && !failed.includes(c.src)
  )
  const canRotate =
    !!provider &&
    !!scope &&
    !detail &&
    !/^\/(artist|album)(?:\/|$)/.test(route) &&
    options.some((c) => c.key !== candidate?.key)
  const next = useCallback(() => {
    if (
      activeVisit.current !== visit ||
      useProviderStore.getState().provider !== provider ||
      provider?.cacheScope !== scope ||
      ambientArtworkController.getWinner(route, provider, scope) ||
      /^\/(artist|album)(?:\/|$)/.test(route)
    )
      return
    const choices = candidates.filter(
      (c) =>
        c.key !== visit.selected?.key &&
        !visit.excluded.has(c.key) &&
        !failed.includes(c.src)
    )
    if (!choices.length) return
    visit.selected =
      choices[
        Math.min(choices.length - 1, Math.floor(Math.random() * choices.length))
      ]
    visit.attempts = 1
    retry()
  }, [visit, candidates, failed, provider, scope, route])
  useEffect(() => {
    if (!backgroundEnabled || !rotationEnabled || !visible || !canRotate) return
    const timer = setInterval(next, 45_000)
    return () => clearInterval(timer)
  }, [backgroundEnabled, rotationEnabled, visible, canRotate, next])
  const poolArtwork = useMemo<AmbientArtwork | null>(
    () =>
      provider && scope && src
        ? {
            src,
            route,
            scope,
            owner:
              playlistRoute && candidate
                ? `ambient-playlist:${candidate.key}`
                : "ambient-pool",
            origin: "pool",
            position: "50% 50%",
            align,
          }
        : null,
    [provider, scope, src, route, align, playlistRoute, candidate?.key]
  )
  const artwork = detail ?? poolArtwork
  const activeArtwork = useRef(artwork)
  useLayoutEffect(() => {
    activeArtwork.current = artwork
  }, [artwork])
  const onFailure = (source: string) => {
    if (
      activeVisit.current !== visit ||
      useProviderStore.getState().provider !== provider ||
      provider?.cacheScope !== scope ||
      artwork?.src !== source ||
      activeArtwork.current?.src !== source
    )
      return
    const currentDetail = ambientArtworkController.getWinner(
      route,
      provider,
      scope
    )
    if (currentDetail) {
      ambientArtworkController.failCurrent(source, route, provider, scope)
    } else if (artwork.origin === "pool")
      ambientArtworkController.fail(source, provider, scope)
  }
  return {
    artwork,
    onFailure,
    next,
    canRotate,
    playlistOwners: playlistRoute
      ? candidates.map((candidate) => `ambient-playlist:${candidate.key}`)
      : undefined,
  }
}
