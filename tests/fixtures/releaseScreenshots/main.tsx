import React from "react"
import type {
  MusicArtist,
  MusicAlbum,
  MusicTrack,
  MusicPlaylist,
  MusicHub,
} from "../../../src/types/music"
import { createRoot } from "react-dom/client"
import { ArtworkShell } from "../../../src/components/ArtworkShell"
import { SideBar } from "../../../src/components/SideBar"
import { Page } from "../../../src/components/Page"
import { Player } from "../../../src/components/Player"
import { ContextMenu } from "../../../src/components/ContextMenu"
import { useProviderStore } from "../../../src/stores/providerStore"
import { useLibraryStore } from "../../../src/stores/libraryStore"
import { usePlayerStore } from "../../../src/stores/playerStore"
import { useSearchStore } from "../../../src/stores/searchStore"
import { useMetadataSourceStore } from "../../../src/stores/metadataSourceStore"
import { activateMetadataCache } from "../../../src/stores/metadataCache"
import { useArtworkAppearanceStore } from "../../../src/stores/artworkAppearanceStore"
import { useEqStore } from "../../../src/stores/eqStore"
import { useAudioSettingsStore } from "../../../src/stores/audioSettingsStore"
import { useDeviceStore } from "../../../src/stores/deviceStore"
import { engine } from "../../../src/audio/RustAudioEngine"
import { setTheme } from "../../../src/stores/themeStore"
import { setFont } from "../../../src/stores/fontStore"
import { useDeezerMetadataStore } from "../../../src/metadata/deezer/store"
import { useItunesMetadataStore } from "../../../src/metadata/apple/store"
import { useLastfmMetadataStore } from "../../../src/metadata/lastfm/store"
import { useMusicBrainzMetadataStore } from "../../../src/metadata/musicbrainz/store"
import "../../../src/styles.css"

async function setup() {
  const art = (index: number, landscape = false) =>
    `${location.origin}/demo-art/${index}${landscape ? "-landscape" : ""}.svg`
  const names = [
    "Aster Vale",
    "Paper Satellites",
    "Night Garden",
    "Quiet Machines",
    "Northbound",
    "Lumen Field",
  ]
  const artists: (MusicArtist & { type: "artist" })[] = names.map(
    (title, index) => ({
      type: "artist",
      id: `demo-artist-${index}`,
      title,
      thumbUrl: art(index),
      artUrl: art(index, true),
      summary:
        "An independent imaginary ensemble exploring the space between acoustic textures and electronic rhythms. All names and artwork in this preview are synthetic.",
      genres: ["Electronic", "Ambient"],
      styles: ["Downtempo"],
      moods: ["Reflective"],
      userRating: 0,
      addedAt: null,
      guid: null,
    })
  )
  const titles = [
    "After the Blue Hour",
    "Small Constellations",
    "The Slow Bloom",
    "Soft Signals",
    "Maps for Tomorrow",
    "Light Through Glass",
    "Open Water",
    "Late Summer",
    "Parallel Lines",
    "A Quiet Distance",
    "Between Seasons",
    "Still Moving",
  ]
  const albums: (MusicAlbum & { type: "album" })[] = titles.map(
    (title, index) => ({
      type: "album",
      id: `demo-album-${index}`,
      title,
      artistId: artists[index % 6].id,
      artistName: names[index % 6],
      year: 2026 - Math.floor(index / 6),
      releaseDate: `${2026 - Math.floor(index / 6)}-${String(10 - (index % 7)).padStart(2, "0")}-01`,
      thumbUrl: art(index),
      artUrl: art(index, true),
      summary:
        "A fictional release for Hibiki's isolated preview. A collection of warm keys, spacious melodies and carefully layered rhythms.",
      genres: ["Electronic"],
      styles: ["Ambient Pop"],
      moods: ["Calm"],
      labels: ["Demo Archive"],
      studio: "Demo Archive",
      artistThumbUrl: art(index % 6),
      format: null,
      addedAt: null,
      guid: null,
      trackCount: 10,
      albumType: "album",
      userRating: 0,
    })
  )
  // Keep the detail pages coherent: Aster Vale owns these albums and track metadata.
  const artistAlbums = albums.filter(
    (album) => album.artistId === artists[0].id
  )
  const trackNames = [
    "First Light",
    "Window Seat",
    "The Long Way Home",
    "Blue Hour",
    "Without a Map",
    "Still Water",
    "Glasshouse",
    "Everything in Motion",
    "Soft Landing",
    "When the City Sleeps",
  ]
  const tracks: (MusicTrack & { type: "track" })[] = trackNames.map(
    (title, index) => ({
      type: "track",
      id: `demo-track-${index}`,
      title,
      artistId: artists[0].id,
      artistName: names[0],
      albumId: albums[0].id,
      albumName: albums[0].title,
      albumYear: 2026,
      year: 2026,
      trackNumber: index + 1,
      discNumber: 1,
      duration: (194 + index * 13) * 1000,
      thumbUrl: art(0),
      playCount: 0,
      albumThumbUrl: art(0),
      artistThumbUrl: art(0),
      summary: null,
      lastPlayedAt: null,
      channels: 2,
      bitDepth: null,
      samplingRate: 44100,
      streamUrl: null,
      gain: null,
      albumGain: null,
      peak: null,
      loudness: null,
      userRating: 0,
      addedAt: null,
      guid: null,
      ratingCount: 0,
      parentStudio: "Demo Archive",
      bitrate: 320,
      codec: "aac",
      container: "m4a",
    })
  )
  const playlists: (MusicPlaylist & { type: "playlist" })[] = [
    "Evening Drift",
    "Sunday Morning",
    "Focus & Flow",
    "On the Road",
  ].map((title, index) => ({
    type: "playlist",
    id: `demo-playlist-${index}`,
    title,
    smart: false,
    trackCount: 10,
    duration: 2310000,
    thumbUrl: art(index + 2),
    summary: "A synthetic playlist for release preview.",
    addedAt: null,
    guid: null,
  }))
  const mixes = artists.map((artist, index) => ({
    ...playlists[0],
    id: `demo-mix-${index}`,
    title: `${artist.title} Mix`,
    thumbUrl: art(index),
    providerKey: `demo-mix-${index}`,
  }))
  const hubs: MusicHub[] = [
    {
      identifier: "music.mixes.demo",
      title: "Mixes for You",
      style: null,
      layout: "scroller",
      items: mixes,
    },
    {
      identifier: "music.demo.recommended",
      title: "Made for your library",
      style: null,
      layout: "scroller",
      items: albums.slice(3, 9),
    },
  ]
  const findArtist = (id: string) =>
    artists.find((item) => item.id === id) ?? artists[0]
  const findAlbum = (id: string) =>
    albums.find((item) => item.id === id) ?? albums[0]
  const provider: any = {
    name: "Demo library",
    cacheScope: "isolated-release-demo",
    playbackSession: 1,
    capabilities: {
      radio: true,
      sonicSimilarity: true,
      tags: true,
      playlists: true,
      playlistCreate: false,
      djModes: false,
      lyrics: false,
      ratings: false,
      mixTracks: true,
    },
    isConnected: () => true,
    disconnect: async () => {},
    getArtist: async (id: string) => findArtist(id),
    getArtistAlbums: async () => artistAlbums,
    getArtistPopularTracks: async () => tracks,
    getArtistSimilar: async () => artists.slice(1),
    getRelatedHubs: async () => [],
    getAlbum: async (id: string) => findAlbum(id),
    getAlbumTracks: async () => tracks,
    getTrack: async (id: string) => tracks.find((item) => item.id === id),
    getPlaylists: async () => playlists,
    getPlaylist: async () => playlists[0],
    getPlaylistItems: async () => ({
      items: tracks,
      total: tracks.length,
      offset: 0,
    }),
    getLikedTracks: async () => tracks.slice(0, 5),
    getLikedAlbums: async () => albums.slice(0, 4),
    getLikedArtists: async () => artists.slice(0, 3),
    getRecentlyAdded: async () => albums,
    getLatestReleases: async () => albums,
    getHubs: async () => hubs,
    search: async (query: string, type?: string) => {
      const normalized = query.toLowerCase()
      return [...artists, ...albums, ...tracks].filter(
        (item) =>
          (!type || item.type === type) &&
          `${item.title} ${"artistName" in item ? item.artistName : ""} ${"albumName" in item ? item.albumName : ""}`
            .toLowerCase()
            .includes(normalized)
      )
    },
    getMixTracks: async () => tracks,
    buildItemUri: (id: string) => `demo://item/${id}`,
  }
  await useLibraryStore.getState().activateProvider(provider)
  await activateMetadataCache(provider)
  useProviderStore.getState().setProvider(provider)
  useLibraryStore.setState({
    playlists,
    likedTracks: tracks.slice(0, 5),
    likedAlbums: albums.slice(0, 4),
    likedArtists: artists.slice(0, 3),
    recentlyAdded: albums,
    latestReleases: albums.slice(0, 6),
    hubs,
    _playlistsFetchedAt: Date.now(),
  })
  useMetadataSourceStore.setState({ priority: ["plex"] })
  for (const store of [
    useDeezerMetadataStore,
    useItunesMetadataStore,
    useLastfmMetadataStore,
    useMusicBrainzMetadataStore,
  ]) {
    ;(store as any).setState({
      getArtist: async () => null,
      getAlbum: async () => null,
      _hasHydrated: true,
    } as any)
  }
  // The native engine is never initialized. This fixture has no IPC emulator and
  // cannot report successful playback: all transport commands are inert.
  const noop = () => {}
  engine.setVisualizerEnabled = noop
  useEqStore.setState({ syncToEngine: noop })
  useAudioSettingsStore.setState({ syncToEngine: async () => {} })
  useDeviceStore.setState({ initDeviceTracking: noop, dispose: noop })
  usePlayerStore.setState({
    currentTrack: tracks[3],
    queue: tracks,
    isPlaying: false,
    volume: 65,
    positionMs: 71000,
    contextName: albums[0].title,
    contextHref: `/album/${albums[0].id}`,
    waveformLevels: Array.from({ length: 140 }, (_, index) => ({
      start: (index * tracks[3].duration) / 140,
      end: ((index + 1) * tracks[3].duration) / 140,
      loudness: -35 + Math.abs(Math.sin(index * 0.31)) * 29,
    })),
    initAudioEvents: async () => noop,
    playTrack: async () => {},
    playFromUri: async () => {},
    playPlaylist: async () => {},
    playRadio: async () => {},
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
  setTheme("dark")
  setFont("circular")
  useArtworkAppearanceStore.setState({
    backgroundArtworkEnabled: true,
    backgroundRotationEnabled: false,
    artworkColorsEnabled: true,
    interfaceOpacity: 0.76,
  })
  createRoot(document.getElementById("root")!).render(
    <ArtworkShell>
      <div className="relative z-0 flex min-h-0 flex-1 overflow-hidden">
        <SideBar onCreatePlaylist={() => {}} />
        <main className="min-w-0 flex-1" role="main">
          <Page />
        </main>
      </div>
      <Player />
      <ContextMenu />
    </ArtworkShell>
  )
  ;(window as any).releasePreview = {
    ready: true,
    route: async (path: string) => {
      history.pushState({}, "", path)
      dispatchEvent(new PopStateEvent("popstate"))
      if (path === "/search") await useSearchStore.getState().search("Aster")
    },
  }
}
void setup()
