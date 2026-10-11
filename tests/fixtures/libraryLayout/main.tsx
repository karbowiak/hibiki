import React from "react"
import { createRoot } from "react-dom/client"
import { Page } from "../../../src/components/Page.tsx"
import { SideBar } from "../../../src/components/SideBar.tsx"
import { useLibraryStore } from "../../../src/stores/libraryStore.ts"
import { useProviderStore } from "../../../src/stores/providerStore.ts"
import { usePlayerStore } from "../../../src/stores/playerStore.ts"
import { useMetadataSourceStore } from "../../../src/stores/metadataSourceStore.ts"
import { activateMetadataCache } from "../../../src/stores/metadataCache.ts"
import { useDeezerMetadataStore } from "../../../src/metadata/deezer/store.ts"
import { useItunesMetadataStore } from "../../../src/metadata/apple/store.ts"
import { useLastfmMetadataStore } from "../../../src/metadata/lastfm/store.ts"
import "../../../src/styles.css"
;(window as any).visualFixtureReady = false
async function setup() {
  const w = window as any
  w.__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
      if (command === "plugin:app|version") return "0.5.1"
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
      ratings: true,
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
    search: async () => [],
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
  usePlayerStore.setState({
    playTrack: async () => {},
    playFromUri: async () => {},
    playPlaylist: async () => {},
    playRadio: async () => {},
    addToQueue: () => {},
    currentTrack: null,
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
      React.createElement(
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
  }
  ;(window as any).visualFixtureReady = true
}
void setup()
