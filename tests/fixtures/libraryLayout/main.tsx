import React from "react"
import { createRoot } from "react-dom/client"
import { Page } from "../../../src/components/Page.tsx"
import { NotificationToasts } from "../../../src/components/NotificationCenter.tsx"
import { useNotificationCenterStore } from "../../../src/stores/notificationCenterStore.ts"
import { useAccentStore } from "../../../src/stores/accentStore.ts"
import { useUIStore } from "../../../src/stores/uiStore.ts"
import { Player } from "../../../src/components/Player.tsx"
import { engine } from "../../../src/audio/RustAudioEngine.ts"
import { useEqStore } from "../../../src/stores/eqStore.ts"
import { useAudioSettingsStore } from "../../../src/stores/audioSettingsStore.ts"
import { useDeviceStore } from "../../../src/stores/deviceStore.ts"
import { useCompactStore } from "../../../src/stores/compactStore.ts"
import { setTheme } from "../../../src/stores/themeStore.ts"
import { SideBar } from "../../../src/components/SideBar.tsx"
import { useLibraryStore } from "../../../src/stores/libraryStore.ts"
import { useProviderStore } from "../../../src/stores/providerStore.ts"
import { usePlayerStore } from "../../../src/stores/playerStore.ts"
import { useMetadataSourceStore } from "../../../src/stores/metadataSourceStore.ts"
import { activateMetadataCache } from "../../../src/stores/metadataCache.ts"
import { useDeezerMetadataStore } from "../../../src/metadata/deezer/store.ts"
import { useItunesMetadataStore } from "../../../src/metadata/apple/store.ts"
import { useLastfmMetadataStore } from "../../../src/metadata/lastfm/store.ts"
import { useSearchStore } from "../../../src/stores/searchStore.ts"
import "../../../src/styles.css"
;(window as any).visualFixtureReady = false
async function setup() {
  const w = window as any
  const params = new URLSearchParams(location.search)
  const actualPlayer = params.get("player") === "1"
  const notifications = params.get("notifications") === "1"
  const discovery = params.get("discovery") === "1"
  let callback = 0
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: () => ++callback,
    unregisterCallback: () => {},
    invoke: async (command: string) => {
      if (command === "plugin:app|version") return "0.5.3"
      if (command === "plugin:window|is_minimized") return false
      if (command === "audio_get_waveform") return []
      if (command === "get_image_cache_info")
        return { files: 0, bytes: 0, max_files: 4096, max_bytes: 536870912 }
      if (command === "get_media_ramps") return null
      if (command === "plugin:event|listen") return 1
      if (command === "plugin:event|unlisten") return null
      throw Error("Synthetic unsupported IPC: " + command)
    },
  }
  const thumb = location.origin + "/synthetic-artwork/cover.svg"
  const artist = {
    type: "artist",
    id: "fixture-artist",
    title: "The Midnight Ensemble and the City Orchestra",
    thumbUrl: thumb,
    artUrl: thumb,
    summary:
      "A synthetic ensemble for layout review. This preview contains no account or playback data.",
    genres: ["Alternative", "Jazz"],
    styles: ["Experimental"],
    moods: ["Reflective"],
    userRating: 8,
    guid: null,
  }
  const album = {
    type: "album",
    id: "fixture-album",
    title: "Live at the Concert Hall: The Complete Deluxe Edition",
    artistId: artist.id,
    artistName: artist.title,
    year: 2025,
    thumbUrl: thumb,
    artUrl: thumb,
    summary: "A synthetic concert album used to exercise the real page layout.",
    genres: ["Alternative"],
    styles: [],
    moods: [],
    userRating: 8,
    albumType: "album",
    labels: [],
    studio: null,
    artistThumbUrl: thumb,
    format: null,
    addedAt: null,
    guid: null,
    trackCount: 12,
  }
  const albums = Array.from({ length: 16 }, (_, i) => ({
    ...album,
    id: "fixture-album-" + i,
    title: i === 0 ? album.title : "Synthetic album " + (i + 1),
    year: 2010 + i,
    guid: "synthetic-album-" + i,
  }))
  const tracks = Array.from({ length: 12 }, (_, i) => ({
    type: "track",
    id: "fixture-track-" + i,
    title:
      i === 0
        ? "A Long Opening Track Title for the Midnight Ensemble"
        : "Synthetic track " + (i + 1),
    artistId: artist.id,
    artistName: artist.title,
    albumId: album.id,
    albumName: album.title,
    albumYear: 2025,
    year: 2025,
    trackNumber: i + 1,
    discNumber: 1,
    duration: 185000,
    thumbUrl: thumb,
    playCount: 2,
    userRating: 8,
    addedAt: null,
    guid: null,
    ratingCount: 0,
    parentStudio: null,
    bitrate: 320,
    codec: "aac",
    container: "m4a",
  }))
  const playlists = Array.from({ length: 18 }, (_, i) => ({
    type: "playlist",
    id: "fixture-playlist-" + i,
    title:
      i === 0
        ? "An exceptionally long synthetic playlist title for gallery truncation"
        : "Synthetic playlist " + (i + 1),
    smart: false,
    trackCount: 12,
    duration: 2000000,
    thumbUrl: thumb,
    summary: "",
    addedAt: null,
    guid: null,
  }))
  const provider = {
    cacheScope: "synthetic-visual-library",
    capabilities: {
      radio: true,
      sonicSimilarity: true,
      tags: true,
      playlists: true,
      playlistCreate: true,
      djModes: true,
      lyrics: true,
      ratings: true,
      ...(discovery ? { mixTracks: true, stations: true } : {}),
    },
    getArtist: async () => artist,
    getArtistAlbums: async () => albums,
    getArtistPopularTracks: async () => tracks,
    getArtistSimilar: async () => [artist],
    getRelatedHubs: async () => [],
    getAlbum: async () => album,
    getAlbumTracks: async () => tracks,
    getLikedTracks: async () => tracks,
    getLikedAlbums: async () => albums,
    getLikedArtists: async () => [artist],
    getPlaylists: async () => playlists,
    search: async () =>
      discovery ? [artist, album, ...tracks.slice(0, 3)] : [],
    getMixTracks: async () => tracks,
    getPlaylistItems: async () => ({ items: tracks, total: tracks.length }),
    buildItemUri: (key: string) => "synthetic://" + key,
    disconnect: async () => {},
  }
  await useLibraryStore.getState().activateProvider(provider)
  await activateMetadataCache(provider)
  useProviderStore.getState().setProvider(provider)
  useLibraryStore.setState({
    playlists,
    likedTracks: tracks,
    likedAlbums: albums,
    likedArtists: [artist],
    _playlistsFetchedAt: Date.now(),
  })
  const noop = () => {}
  engine.setVisualizerEnabled = noop
  useEqStore.setState({ syncToEngine: noop })
  useAudioSettingsStore.setState({ syncToEngine: async () => {} })
  useDeviceStore.setState({ initDeviceTracking: noop, dispose: noop })
  usePlayerStore.setState({
    playTrack: async () => {},
    playFromUri: async () => {},
    playPlaylist: async () => {},
    playRadio: async () => {},
    addToQueue: () => {},
    currentTrack: actualPlayer ? tracks[0] : null,
    queue: tracks,
    isPlaying: false,
    isInternetRadioActive: false,
    volume: 0,
    positionMs: 42000,
    contextName:
      "A very long synthetic playlist context used to check footer alignment",
    contextHref: "/playlist/fixture-playlist-0",
    lyricsLines: [{ time: 0, text: "Synthetic lyric" }],
    waveformLevels: Array.from({ length: 120 }, () => 0.3),
    initAudioEvents: async () => noop,
    pause: noop,
    resume: noop,
    next: noop,
    prev: noop,
    stop: noop,
    seekTo: noop,
    setVolume: noop,
    toggleMute: noop,
    toggleShuffle: noop,
    cycleRepeat: noop,
  })
  useMetadataSourceStore.setState({ priority: ["plex"] })
  for (const store of [
    useDeezerMetadataStore,
    useItunesMetadataStore,
    useLastfmMetadataStore,
  ])
    store.setState({
      getArtist: async () => null,
      getAlbum: async () => null,
      _hasHydrated: true,
    })
  const setHome = (count: number) => {
    const mixes = playlists.slice(0, count).map((playlist, index) => ({
      ...playlist,
      id: `fixture-mix-${index}`,
      title: `Fixture artist ${index + 1} Mix`,
      providerKey: `synthetic-mix-${index}`,
    }))
    useLibraryStore.setState({
      recentlyAdded: albums.slice(0, 8),
      hubs: [
        {
          identifier: "music.mixes.fixture",
          title: "Mixes for You",
          items: mixes,
        },
        {
          identifier: "music.fixture.recommended",
          title: "Recommended for Your Library",
          items: albums.slice(0, 8),
        },
      ],
    })
  }
  setHome(5)
  if (discovery) {
    const recentArtists = Array.from({ length: 6 }, (_, index) => ({
      ...artist,
      id: `recent-artist-${index}`,
      title: index === 0 ? artist.title : `Recent artist ${index + 1}`,
    }))
    const mixes = playlists.slice(0, 7).map((playlist, index) => ({
      ...playlist,
      id: "0", // Real Plex hub mixes deliberately share this placeholder ID.
      title: `Discovery artist ${index + 1} Mix`,
      providerKey: `discovery-mix-${index}`,
    }))
    const discoveryHubs = [
      {
        identifier: "music.recent.played.fixture",
        title: "Recently Played Music",
        items: recentArtists,
      },
      {
        identifier: "music.mixes.fixture",
        title: "Mixes For You",
        items: mixes,
      },
      {
        identifier: "music.recent.artist.fixture",
        title: "More by the Midnight Ensemble",
        items: albums.slice(0, 6),
      },
      {
        identifier: "music.vault.fixture",
        title: "Haven't played in 11 months",
        items: [
          { ...artist, id: "rediscovery-artist", title: "Rediscovery artist" },
        ],
      },
      {
        identifier: "music.recent.added.fixture",
        title: "Recently Added",
        items: albums.slice(8),
      },
    ]
    useLibraryStore.setState({ hubs: discoveryHubs as any })
    w.fixtureSearch = {
      query: (query: string) => useSearchStore.getState().search(query),
      clear: () => useSearchStore.getState().clear(),
      connected: (connected: boolean) =>
        useProviderStore.setState({
          provider: connected ? (provider as any) : null,
        }),
      theme: (theme: "dark" | "light") => setTheme(theme),
    }
    history.pushState({}, "", "/search")
  }
  w.setFixtureHome = (
    count: number,
    compact = false,
    theme = "dark",
    activeModes = false,
    expandedArt = false
  ) => {
    setHome(count)
    useAccentStore.getState().setAccent("#d4a574")
    useUIStore.setState({ isArtExpanded: expandedArt })
    usePlayerStore.setState({
      djMode: activeModes ? "anno" : null,
      isRadioMode: activeModes,
    })
    useCompactStore.getState().setCompact(compact)
    setTheme(theme as "dark" | "light")
    history.pushState({}, "", "/")
    dispatchEvent(new PopStateEvent("popstate"))
  }
  if (notifications) {
    let retryCalls = 0
    let completeRetry: (() => void) | undefined
    const warning = (
      message = "Synthetic pending listens are waiting for retry."
    ) => ({
      id: "fixture-warning",
      title: "Fixture listening sync requires attention",
      message,
      severity: "warning" as const,
      persistent: true,
      action: {
        label: "Retry fixture",
        run: async () => {
          ++retryCalls
          await new Promise<void>((resolve) => {
            completeRetry = resolve
          })
          useNotificationCenterStore.getState().resolve("fixture-warning")
        },
      },
    })
    w.fixtureNotifications = {
      seed: () => {
        const center = useNotificationCenterStore.getState()
        center.notify({
          id: "fixture-info",
          title: "Fixture refresh finished",
          message: "Your synthetic library is up to date.",
          severity: "success",
        })
        center.notify(warning())
        center.notify({
          id: "fixture-error",
          title: "Fixture decoder message",
          message:
            "This is an intentionally long synthetic diagnostic: " +
            "LongUnbrokenDiagnostic".repeat(10),
          severity: "error",
        })
      },
      poll: () =>
        useNotificationCenterStore
          .getState()
          .notify(
            warning("Still waiting after the next synthetic status poll.")
          ),
      recur: () => {
        useNotificationCenterStore.getState().resolve("fixture-warning")
        useNotificationCenterStore.getState().notify(warning())
      },
      finishRetry: () => completeRetry?.(),
      retryCalls: () => retryCalls,
      snapshot: () =>
        useNotificationCenterStore
          .getState()
          .notifications.map(({ action, ...entry }) => ({
            ...entry,
            hasAction: !!action,
          })),
      theme: (theme: "dark" | "light") => setTheme(theme),
    }
  }
  document.getElementById("root")!.style.display = "none"
  const host = document.createElement("div")
  host.id = "layout-fixture"
  host.className = "flex h-screen flex-col overflow-hidden text-white"
  document.body.append(host)
  createRoot(host).render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "div",
        {
          className:
            "relative z-0 flex min-h-0 flex-1 flex-row overflow-hidden",
        },
        React.createElement(SideBar, { onCreatePlaylist: () => {} }),
        React.createElement(
          "main",
          { className: "min-w-0 flex-1", role: "main" },
          React.createElement(Page)
        )
      ),
      notifications ? React.createElement(NotificationToasts) : null,
      actualPlayer
        ? React.createElement(Player)
        : React.createElement(
            "div",
            {
              style: {
                height: "88px",
                background: "#161616",
                flexShrink: 0,
                padding: "20px",
              },
            },
            "Synthetic player area — playback disabled"
          )
    )
  )
  ;(window as any).setFixtureSidebarWidth = (width: number) => {
    const sidebar = document.querySelector<HTMLElement>(
      '#layout-fixture nav[aria-label="Main navigation"]'
    )
    if (!sidebar) throw new Error("Fixture sidebar missing")
    sidebar.style.width = `${width}px`
    window.dispatchEvent(
      new CustomEvent("resizable-change", {
        detail: { key: "plex-sidebar-width", width },
      })
    )
  }
  ;(window as any).visualFixtureReady = true
}
void setup()
