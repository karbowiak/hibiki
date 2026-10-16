import { usePodcastStore } from "../../../src/backends/podcast/store.ts"
import { useRadioStreamStore } from "../../../src/stores/radioStreamStore.ts"
import { useGlobalHotkeys } from "../../../src/hooks/useGlobalHotkeys.ts"
import { HotkeyHelpModal } from "../../../src/components/HotkeyHelpModal.tsx"
import { ContextMenu } from "../../../src/components/ContextMenu.tsx"
import React from "react"
import { createRoot } from "react-dom/client"
import { ArtworkShell } from "../../../src/components/ArtworkShell.tsx"
import { useArtworkAppearanceStore } from "../../../src/stores/artworkAppearanceStore.ts"
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
import { useVisualizerStore, type FullscreenVisualizerMode } from "../../../src/stores/visualizerStore.ts"
import { useDebugStore } from "../../../src/stores/debugStore.ts"
import { useLyricsStore } from "../../../src/stores/lyricsStore.ts"
import { useMetadataSourceStore } from "../../../src/stores/metadataSourceStore.ts"
import { activateMetadataCache, clearMetadataCache } from "../../../src/stores/metadataCache.ts"
import { useDeezerMetadataStore } from "../../../src/metadata/deezer/store.ts"
import { useItunesMetadataStore } from "../../../src/metadata/apple/store.ts"
import { useLastfmMetadataStore } from "../../../src/metadata/lastfm/store.ts"
import { useSearchStore } from "../../../src/stores/searchStore.ts"
import { setFont } from "../../../src/stores/fontStore.ts"
import { useCardSizeStore } from "../../../src/stores/cardSizeStore.ts"
import { useCustomColorStore } from "../../../src/stores/customColorStore.ts"
import { QueuePanel } from "../../../src/components/QueuePanel.tsx"
import LyricsPanel from "../../../src/components/LyricsPanel.tsx"
import "../../../src/styles.css"
;(window as any).visualFixtureReady = false
async function setup() {
  const w = window as any
  const params = new URLSearchParams(location.search)
  const actualPlayer = params.get("player") === "1"
  const notifications = params.get("notifications") === "1"
  const discovery = params.get("discovery") === "1"
  const appearance = params.get("appearance") === "1"
  let callback = 0
  let loadingGate = Promise.resolve()
  let releaseLoading: (() => void) | null = null
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: () => ++callback,
    unregisterCallback: () => {},
    invoke: async (command: string) => {
      if (command.startsWith("radiobrowser_") || command.startsWith("podcast_")) await loadingGate
      if (
        command === "radiobrowser_top_stations" ||
        command === "radiobrowser_search"
      )
        return stations
      if (command === "radiobrowser_countries")
        return [{ name: "Denmark", code: "DK", station_count: 10 }]
      if (command === "radiobrowser_tags")
        return [{ name: "Electronic", station_count: 10 }]
      if (command === "podcast_get_top") return podcastCharts
      if (command === "podcast_get_categories")
        return [{ id: 1, name: "Music" }]
      if (command === "podcast_get_feed") return podcastDetail
      if (command === "podcast_lookup") return { feed_url: podcastFeed }
      if (command === "plugin:app|version") return "0.5.3"
      if (command === "plugin:window|is_minimized") return false
      if (command === "plugin:window|is_fullscreen") return false
      if (command === "plugin:window|set_fullscreen") return null
      if (command === "audio_get_waveform") return []
      if (command === "get_image_cache_info")
        return { files: 0, bytes: 0, max_files: 4096, max_bytes: 536870912 }
      if (command === "get_media_ramps") return null
      if (command === "refresh_image") return { revision: "synthetic-refresh" }
      if (command === "plugin:event|listen") return 1
      if (command === "plugin:event|unlisten") return null
      throw Error("Synthetic unsupported IPC: " + command)
    },
  }
  const thumb = location.origin + "/synthetic-artwork/cover.svg"
  const podcastFeed = "https://synthetic.invalid/music.xml"
  const podcastCharts = Array.from({ length: 8 }, (_, i) => ({
    itunes_id: i + 1,
    name: "Synthetic podcast " + (i + 1),
    artist_name: "Fixture broadcaster",
    artwork_url: thumb,
    feed_url: podcastFeed,
    genre: "Music",
    itunes_url: "https://synthetic.invalid/show",
  }))
  const podcastDetail = {
    feed_url: podcastFeed,
    title: "Synthetic podcast 1",
    author: "Fixture broadcaster",
    description:
      "A synthetic show with a long episode description for layout review.",
    artwork_url: thumb,
    link: "https://synthetic.invalid/show",
    language: "en",
    categories: ["Music"],
    episodes: Array.from({ length: 6 }, (_, i) => ({
      guid: "episode-" + i,
      title: "Synthetic episode " + (i + 1),
      description: "A synthetic episode. No listening account is used.",
      pub_date: "2026-10-10T12:00:00Z",
      duration_secs: 3600,
      audio_url: "https://synthetic.invalid/audio.mp3",
      audio_type: "audio/mpeg",
      audio_size: 1000,
      episode_number: i + 1,
      season_number: 1,
      artwork_url: null,
    })),
  }
  const stations = Array.from({ length: 8 }, (_, i) => ({
    uuid: "station-" + i,
    name: "Synthetic station " + (i + 1),
    stream_url: "https://synthetic.invalid/live",
    homepage: "https://synthetic.invalid",
    favicon: thumb,
    tags: ["Electronic"],
    country: "Denmark",
    country_code: "DK",
    language: "Danish",
    codec: "MP3",
    bitrate: 128,
    is_hls: false,
    votes: 20,
    click_count: 10,
    click_trend: 1,
  }))
  usePodcastStore.setState({
    subscriptions: [
      {
        feedUrl: podcastFeed,
        title: podcastDetail.title,
        author: podcastDetail.author,
        artworkUrl: thumb,
        addedAt: 0,
      },
    ],
    feedCache: {},
    topChartCache: {},
  })
  useRadioStreamStore.setState({
    favorites: [stations[0]],
    recentStations: stations.slice(0, 2),
    playStation: async () => {},
  })
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
    getArtist: async () => { await loadingGate; return artist },
    getArtistAlbums: async () => albums,
    getArtistPopularTracks: async () => tracks,
    getArtistSimilar: async () => [artist],
    getRelatedHubs: async () => [],
    getAlbum: async () => { await loadingGate; return album },
    getAlbumTracks: async () => tracks,
    getTrack: async (id: string) => ({ ...tracks.find(t => t.id === id)!,
      bitDepth: 24, samplingRate: 44100, channels: 2, gain: -3.4,
      albumGain: -3.4, loudness: -15, peak: 0.965,
      mediaInfo: { fileSize: 9200000, container: "m4a" },
      _providerData: { media: [{ parts: [{ file: "/synthetic/An exceptionally long directory name/An exceptionally long album name/Opening Track.m4a" }] }] },
    }),
    getLikedTracks: async () => tracks,
    getLikedAlbums: async () => albums,
    getLikedArtists: async () => [artist],
    getPlaylists: async () => playlists,
    search: async () =>
      discovery ? [artist, album, ...tracks.slice(0, 3)] : [],
    getMixTracks: async () => tracks,
    getPlaylistItems: async () => { await loadingGate; return { items: tracks, total: tracks.length } },
    addToPlaylist: async (id: string, ids: string[]) => { playlistDrops.push({ id, ids }) },
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
  const interactions: { action: string; id?: string; position?: number }[] = []
  const playlistDrops: { id: string; ids: string[] }[] = []
  w.fixturePlaylistDrops = () => playlistDrops
  w.fixtureLoading = {
    hold: async () => {
      releaseLoading?.()
      loadingGate = new Promise<void>(resolve => { releaseLoading = resolve })
      await clearMetadataCache()
      usePodcastStore.setState({ feedCache: {}, topChartCache: {} })
      useLibraryStore.setState({ playlistItemsCache: {}, playlistIsFullyLoaded: {} })
    },
    release: () => { releaseLoading?.(); releaseLoading = null; loadingGate = Promise.resolve() },
  }
  engine.setVisualizerEnabled = noop
  useEqStore.setState({ syncToEngine: noop })
  useAudioSettingsStore.setState({ syncToEngine: async () => {} })
  useDeviceStore.setState({ initDeviceTracking: noop, dispose: noop })
  usePlayerStore.setState({
    playTrack: async (track) => {
      interactions.push({ action: "play", id: track.id })
    },
    playFromUri: async () => {},
    playPlaylist: async () => {},
    playRadio: async () => {},
    addToQueue: (items) => {
      interactions.push({ action: "queue", id: items[0]?.id })
    },
    jumpToQueueItem: (index) => {
      interactions.push({ action: "jump", id: tracks[index]?.id })
    },
    currentTrack: actualPlayer ? tracks[0] : null,
    queue: tracks,
    isPlaying: false,
    isInternetRadioActive: false,
    volume: 0,
    positionMs: 42000,
    contextName:
      "A very long synthetic playlist context used to check footer alignment",
    contextHref: "/playlist/fixture-playlist-0",
    lyricsLines: [
      {
        startMs: 0,
        endMs: 100000,
        text: "Synthetic lyric with a long line that wraps in a narrow panel",
      },
    ],
    waveformLevels: Array.from({ length: 120 }, (_, i) => ({
      start: i * 1541,
      end: (i + 1) * 1541,
      loudness: -28 + Math.sin(i * 0.17) * 17,
    })),
    initAudioEvents: async () => noop,
    pause: noop,
    resume: noop,
    next: noop,
    prev: noop,
    stop: noop,
    seekTo: (position) => {
      interactions.push({ action: "seek", position })
    },
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
  w.fixtureAppearance = {
    visualizer: (fullscreenMode: FullscreenVisualizerMode) =>
      useVisualizerStore.setState({ fullscreenMode, autoCycleEnabled: false }),
    lyricsPreview: (plain = false, positionMs = 42000) => {
      const lines = ["The city lights are fading", "We're following the tide", "Every road is open",
        "With you here by my side", "Let the night keep moving", "Till the morning comes around",
        "We'll remember every moment", "Every rhythm, every sound"].map((text, i) => ({ text,
          startMs: i * 12000, endMs: (i + 1) * 12000 }))
      useLyricsStore.setState({ sources: [{ id: "fixture", label: "Plex", lines, isSynced: !plain }], activeSourceId: "fixture", geniusHits: [] })
      usePlayerStore.setState({ currentTrack: tracks[0], lyricsLines: lines, positionMs })
    },
    apply: ({
      font = "circular",
      cardSize = 160,
      compact = false,
      theme = "dark",
      custom = false,
      textSize = 16,
      background = true,
      opacity = 0.76,
      artworkColors = true,
      rotation = false,
    }) => {
      useArtworkAppearanceStore
        .getState()
        .setBackgroundRotationEnabled(rotation)
      useArtworkAppearanceStore
        .getState()
        .setBackgroundArtworkEnabled(background)
      useArtworkAppearanceStore.getState().setInterfaceOpacity(opacity)
      useArtworkAppearanceStore
        .getState()
        .setArtworkColorsEnabled(artworkColors)
      setFont(font)
      useCardSizeStore.getState().setCardSize(cardSize)
      useCompactStore.getState().setCompact(compact)
      setTheme(theme)
      const colors = useCustomColorStore.getState()
      colors.resetAll()
      if (custom) {
        for (const [key, value] of Object.entries({
          "bg-base": "#162530",
          "bg-elevated": "#203747",
          "bg-surface": "#284455",
          "bg-surface-hover": "#35596e",
          "text-primary": "#e6f5ff",
          "text-secondary": "#bddeef",
          "text-muted": "#94bfd4",
          border: "#51758b",
        }))
          colors.setOverride(key as any, value)
        colors.setEnabled(true)
      }
      document.documentElement.style.fontSize = `${textSize}px`
    },
    route: (path: string) => {
      history.pushState({}, "", path)
      dispatchEvent(new PopStateEvent("popstate"))
    },
    interactions: () => interactions,
    trackInfo: (debug = false) => {
      useDebugStore.setState({ debugEnabled: debug })
      usePlayerStore.setState({ transitionInfo: {
        outgoing_rating_key: 1, incoming_rating_key: 2, mode: "mixRamp",
        reason: null, start_time_ms: 170000, duration_ms: 15000,
      } })
    },
    resetInteractions: () => {
      interactions.length = 0
    },
    panel: (panel: "queue" | "lyrics" | null, pinned = false) =>
      useUIStore.setState({
        isQueueOpen: panel === "queue",
        isQueuePinned: panel === "queue" && pinned,
        isLyricsOpen: panel === "lyrics",
        isLyricsPinned: panel === "lyrics" && pinned,
      }),
    lyrics: (mode: "idle" | "loading" | "empty" | "ready") =>
      usePlayerStore.setState({
        currentTrack: mode === "idle" ? null : tracks[0],
        lyricsLines:
          mode === "loading"
            ? null
            : mode === "empty"
              ? []
              : [
                  {
                    startMs: 0,
                    endMs: 100000,
                    text: "Synthetic lyric with a long line that wraps in a narrow panel",
                  },
                ],
      }),
  }
  w.fixtureArtwork = {
    detailBackground: async (name: string) => {
      w.fixtureArtwork.replace("cover.svg")
      artist.artUrl = album.artUrl = location.origin + "/synthetic-artwork/" + name
      await clearMetadataCache()
    },
    focusBackground: async () => {
      const src = location.origin + "/synthetic-artwork/portrait.svg"
      artist.artUrl = artist.thumbUrl = album.artUrl = album.thumbUrl = album.artistThumbUrl = src
      for (const track of tracks) track.thumbUrl = src
      // All eligible member sources must use the portrait: playlist rotation
      // legitimately chooses either artist or album artwork.
      w.fixtureArtwork.replace("portrait.svg")
      useLibraryStore.setState({ playlistItemsCache: {}, playlistIsFullyLoaded: {}, currentPlaylistItems: [...tracks] })
      await clearMetadataCache()
    },
    replace: (name: string) => {
      const src = location.origin + "/synthetic-artwork/" + name
      const library = useLibraryStore.getState()
      const update = (item: any) => ({
        ...item,
        thumbUrl: src,
        artUrl: src,
        albumThumbUrl: src,
      })
      useLibraryStore.setState({
        likedArtists: library.likedArtists?.map(update) ?? [],
        likedAlbums: library.likedAlbums?.map(update) ?? [],
        recentlyAdded: library.recentlyAdded.map(update),
        latestReleases: library.latestReleases.map(update),
        likedTracks: library.likedTracks?.map(update) ?? [],
        playlists: library.playlists.map(update),
        hubs: library.hubs.map((hub) => ({
          ...hub,
          items: hub.items.map(update),
        })),
      })
    },
    multiple: () => {
      const library = useLibraryStore.getState()
      useLibraryStore.setState({
        likedArtists: [
          ...(library.likedArtists ?? []),
          {
            ...artist,
            id: "next-artist",
            title: "Next artist",
            artUrl: location.origin + "/synthetic-artwork/next.svg",
            thumbUrl: location.origin + "/synthetic-artwork/next.svg",
          },
        ],
      })
    },
    retire: () => useProviderStore.getState().clearProvider(),
  }
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
      InteractionHarness,
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
        ),
        appearance ? React.createElement(QueuePanel) : null,
        appearance ? React.createElement(LyricsPanel) : null
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

function InteractionHarness({ children }: { children: React.ReactNode }) {
  const { hotkeyHelpOpen, setHotkeyHelpOpen } = useGlobalHotkeys()
  return (
    <ArtworkShell>
      {children}
      <ContextMenu />
      {hotkeyHelpOpen && <HotkeyHelpModal context="visualizer" onClose={() => setHotkeyHelpOpen(false)} />}
    </ArtworkShell>
  )
}
