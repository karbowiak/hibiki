import { ArtworkImage } from "../shared/ArtworkImage"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useLocation } from "wouter"
import { capturePlaybackSelectionVersion, usePlayerStore } from "../../stores/playerStore"
import { useProviderStore } from "../../stores/providerStore"
import { useCapability } from "../../hooks/useCapability"
import type { MusicItem } from "../../types/music"

interface Props {
  stationType: string
}

// Station types that require artist/album context — keep as placeholders
const PLACEHOLDER_TYPES = new Set(["artist-mix", "album-mix"])

export function RadioPage({ stationType }: Props) {
  const [, navigate] = useLocation()
  const hasRadio = useCapability("radio")
  const provider = useProviderStore(s => s.provider)
  const playFromUri = usePlayerStore(s => s.playFromUri)
  const currentTrack = usePlayerStore(s => s.currentTrack)

  const [stationItem, setStationItem] = useState<MusicItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const viewRef = useRef<{ active: boolean } | null>(null)
  // Page decodes the raw route segment once. Provider identifiers are opaque.
  const decoded = stationType
  const isPlaceholder = PLACEHOLDER_TYPES.has(decoded)

  useEffect(() => {
    if (!hasRadio) navigate("/")
  }, [hasRadio, navigate])

  useLayoutEffect(() => {
    const view = { active: true }
    viewRef.current = view
    const current = () => view.active && useProviderStore.getState().provider === provider
    const selection = capturePlaybackSelectionVersion()
    setStationItem(null)
    setNotFound(false)
    setLoadError(false)
    setLoading(false)
    if (!hasRadio || isPlaceholder) return () => { view.active = false }
    if (!provider?.getSectionStations) {
      setNotFound(true)
      return () => { view.active = false }
    }
    setLoading(true)
    void (async () => {
      try {
        const hubs = await provider.getSectionStations!()
        if (!current()) return
        const match = hubs.flatMap(hub => hub.items).find(item =>
          item.guid === `tv.plex://station/${decoded}` || (item.providerKey && item.providerKey.includes(decoded)))
        const uri = match?.providerKey ? provider.buildRadioUri?.(match.providerKey) : null
        if (!match || !uri) { setNotFound(true); return }
        setStationItem(match)
        // Explicit playback elsewhere supersedes this pending route autoplay.
        if (capturePlaybackSelectionVersion() === selection) {
          const playback = playFromUri(uri)
          const acceptedSelection = capturePlaybackSelectionVersion()
          void playback.catch(() => {
            if (current() && capturePlaybackSelectionVersion() === acceptedSelection) setLoadError(true)
          })
        }
      } catch {
        if (current()) setLoadError(true)
      } finally {
        if (current()) setLoading(false)
      }
    })()
    return () => { view.active = false }
  }, [decoded, provider, hasRadio, isPlaceholder, attempt, playFromUri])

  const handlePlay = () => {
    if (!stationItem?.providerKey || useProviderStore.getState().provider !== provider) return
    try {
      const uri = provider?.buildRadioUri?.(stationItem.providerKey)
      if (!uri) return
      const view = viewRef.current
      setLoadError(false)
      const playback = playFromUri(uri)
      const acceptedSelection = capturePlaybackSelectionVersion()
      void playback.catch(() => {
        if (view?.active && useProviderStore.getState().provider === provider && capturePlaybackSelectionVersion() === acceptedSelection) setLoadError(true)
      })
    } catch { setLoadError(true) }
  }

  if (!hasRadio) return null
  if (loadError) return (
    <div role="alert" className="p-8 text-sm text-red-400">
      <p>Could not load this station.</p>
      <button onClick={() => setAttempt(value => value + 1)} className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white">Try again</button>
    </div>
  )

  // Placeholder state
  if (isPlaceholder) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-white/10">
          <svg height="40" width="40" viewBox="0 0 24 24" fill="currentColor" className="text-white/60">
            <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zm-2 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
          </svg>
        </div>
        <h1 className="mb-2 text-3xl font-bold">
          {decoded === "artist-mix" ? "Artist Mix Builder" : "Album Mix Builder"}
        </h1>
        <p className="mb-8 max-w-sm text-sm text-white/60">
          {decoded === "artist-mix"
            ? "Build a personalised mix from a specific artist. Navigate to an artist page and use the radio button there."
            : "Build a mix inspired by a specific album. Navigate to an album page and use the radio button there."}
        </p>
        <span className="rounded-full bg-white/10 px-4 py-1.5 text-xs font-medium text-white/50">
          Coming soon
        </span>
      </div>
    )
  }

  // Loading state
  if (loading) {
    return (
      <div role="status" aria-label="Loading station" className="flex items-center justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    )
  }

  // Not found on this server
  if (notFound || !stationItem) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/5">
          <svg height="32" width="32" viewBox="0 0 24 24" fill="currentColor" className="text-white/30">
            <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zm-2 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
          </svg>
        </div>
        <h1 className="mb-2 text-xl font-bold">Station unavailable</h1>
        <p className="text-sm text-white/50">This station isn't available on your server.</p>
      </div>
    )
  }

  const thumb = stationItem.thumbUrl ?? null

  const nowPlayingThumb = currentTrack?.thumbUrl ?? null

  return (
    <div className="flex flex-col items-center py-16 text-center">
      {/* Station art / icon */}
      <div className="mb-6 h-40 w-40 overflow-hidden rounded-xl shadow-2xl flex items-center justify-center bg-gradient-to-br from-[#2d1b4e] to-[#1a3a5c]">
        {thumb ? (
          <ArtworkImage loading="eager" src={thumb} alt="" className="h-full w-full object-cover" />
        ) : (
          <svg height="64" width="64" viewBox="0 0 24 24" fill="currentColor" className="text-white/40">
            <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zm-2 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
          </svg>
        )}
      </div>

      <h1 className="mb-1 text-3xl font-bold">{stationItem.title}</h1>
      <p className="mb-8 text-sm text-white/50">Radio Station</p>

      {/* Play button */}
      <button
        onClick={handlePlay}
        className="mb-12 flex items-center gap-3 rounded-full bg-accent px-8 py-3 text-sm font-bold text-black hover:brightness-110 transition-colors"
      >
        <svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z" />
        </svg>
        Play Station
      </button>

      {/* Now playing */}
      {currentTrack && (
        <div className="w-full max-w-md rounded-xl bg-white/5 p-4 text-left">
          <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">
            Now Playing
          </div>
          <div className="flex items-center gap-3">
            {nowPlayingThumb ? (
              <ArtworkImage loading="eager" src={nowPlayingThumb} alt="" className="h-12 w-12 rounded object-cover flex-shrink-0" />
            ) : (
              <div className="h-12 w-12 rounded bg-white/10 flex-shrink-0" />
            )}
            <div className="min-w-0">
              <div className="truncate font-semibold text-white">{currentTrack.title}</div>
              <div className="truncate text-sm text-white/50">
                {currentTrack.artistName} · {currentTrack.albumName}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
