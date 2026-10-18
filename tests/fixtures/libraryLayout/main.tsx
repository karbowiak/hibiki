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
import { CreatePlaylist } from "../../../src/components/Pages/CreatePlaylist.tsx"
import { engine } from "../../../src/audio/RustAudioEngine.ts"
import { useEqStore } from "../../../src/stores/eqStore.ts"
import { useAudioSettingsStore } from "../../../src/stores/audioSettingsStore.ts"
import { useDeviceStore } from "../../../src/stores/deviceStore.ts"
import { useCompactStore } from "../../../src/stores/compactStore.ts"
import { setTheme } from "../../../src/stores/themeStore.ts"
import { SideBar } from "../../../src/components/SideBar.tsx"
import { useLibraryStore } from "../../../src/stores/libraryStore.ts"
import { useFavoritesStore } from "../../../src/stores/favoritesStore.ts"
import { emptyFavorites } from "../../../src/favorites/model.ts"
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
import { youtubeMusicTrack } from "../../../src/backends/ytmusic/tracks.ts"
import { useYoutubeMusicDiscoveryStore } from "../../../src/backends/ytmusic/discovery.ts"
import { useYoutubeMusicRatingsStore } from "../../../src/backends/ytmusic/ratings.ts"
import { useMixedPlaylistStore } from "../../../src/stores/mixedPlaylistStore.ts"
import { newDraft, defaultPlaylistSync } from "../../../src/mixedPlaylists/drafts.ts"
import { mixedPlaylistRepository } from "../../../src/mixedPlaylists/repository.ts"
import { hydratePlaylist, newOccurrence } from "../../../src/mixedPlaylists/model.ts"
import { COUNTERPART_POLICY } from "../../../src/mixedPlaylists/matching.ts"
import { HoverInformation } from "../../../src/components/HoverInformation.tsx"
import { useCatalogueStore } from "../../../src/offline/catalogueStore.ts"
import { initializeQueuePersistence, flushQueuePersistence } from "../../../src/lib/queuePersistence.ts"
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
  const virtual = params.get("virtual") === "1"
  const queueProof = params.get("queue") === "1"
  const informationProof=params.get("information")==="1"
  let diagnosticCalls = 0
  let diagnosticSource = "network"
  const youtubeMetadataCalls: string[] = []
  w.fixtureDiagnostics = { calls: () => diagnosticCalls }
  let callback = 0
  let youtubeArtistEnabled = false
  let youtubeLikesEnabled = false
  let loadingGate = Promise.resolve()
  let releaseLoading: (() => void) | null = null
  let downloadStorage = { directory: "/Users/listener/Music/Hibiki", defaultDirectory: "/Users/listener/Music/Hibiki", moving: false, totalBytes: 2 * 1024 ** 3, tracks: 85, error: null as string | null }
  let storageGate=Promise.resolve(), releaseStorage:(()=>void)|null=null, storageFailure=false
  w.fixtureDownloadStorage={
    hold:()=>{storageGate=new Promise<void>(resolve=>{releaseStorage=resolve})},
    release:()=>{releaseStorage?.();releaseStorage=null;storageGate=Promise.resolve()},
    failNext:()=>{storageFailure=true},
  }
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: () => ++callback,
    unregisterCallback: () => {},
    invoke: async (command: string, args:any={}) => {
      if (/^(?:create_playlist|edit_playlist|ytmusic_playlist_write|save_library_artwork|playlist_sync_listenbrainz_(?:create|mutate|describe))$/.test(command))
        (w.fixturePlaylistWrites ??= []).push(command)
      if (command === "ytmusic_status") return { enabled: youtubeArtistEnabled, phase: youtubeArtistEnabled ? "connected" : "disconnected", accountId: youtubeArtistEnabled ? "fixture-youtube-owner" : null, lastCheckedAt: null, nextRefreshAt: null, message: null }
      if (command === "ytmusic_browse" && args.browseId === "VLPLfixture") return {
        title: "YouTube fixture playlist", thumbnail: thumb, description: "Synthetic playlist for shared layout checks", hubs: [], continuation: null,
        items: tracks.slice(0, 3).map((track, index) => ({ id: `a123456789${index}`, kind: "song", title: track.title, artist: track.artistName, album: track.albumName, thumbnail: thumb, duration: "3:00" })),
      }
      if (command === "ytmusic_browse" && args.browseId === "VLLM" && youtubeLikesEnabled) {
        const song = (id: string, title: string, videoType = "MUSIC_VIDEO_TYPE_ATV") => ({ id, kind: "song", title, artist: tracks[0].artistName, album: tracks[0].albumName, thumbnail: thumb, duration: "3:00", year: null, videoType })
        const first = song("abcdefghijk", tracks[0].title)
        return { title: "Liked Music", hubs: [], items: args.continuation === "one" ? [] : args.continuation === "three"
          ? [song("lmnopqrstuv", "Later saved song"), ...(args.includePerformances ? [song("w1234567890", "Music video song", "MUSIC_VIDEO_TYPE_OMV")] : [])] : [first],
          continuation: !args.continuation ? "one" : args.continuation === "one" ? "two" : args.continuation === "two" ? "three" : null }
      }
      if (command === "ytmusic_browse") return { title: "YouTube Fixture Artist", items: [], hubs: [], continuation: null,
        artist: args.browseId === "UC_fixture" ? { id: "UC_fixture", name: "YouTube Fixture Artist", thumbnail: thumb,
          background: location.origin + "/synthetic-artwork/hero-detail.svg", description: "Fixture artist biography", monthlyListeners: null, subscribers: null, songs: null, shuffle: null } : null }
      if(command==="download_storage_info")return {...downloadStorage}
      if(command==="download_storage_open")return null
      if(command==="download_storage_choose" || command==="download_storage_retry") {
        await storageGate
        if(storageFailure){storageFailure=false;throw "Could not copy downloads. Check free space and permissions."}
        downloadStorage={...downloadStorage,directory:"/Volumes/Music collection/Hibiki"};return {...downloadStorage}
      }
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
      if (command === "audio_get_diagnostics") {
        diagnosticCalls++
        return { requestId: 1, playbackId: 1, ratingKey: 42, state: "playing", positionMs: 42000,
          bufferedSeconds: 24 + Math.sin(diagnosticCalls) * 2, decodedComplete: false,
          mixerRate: 48000, mixerChannels: 2, outputAvailable: true, outputRate: 96000, outputChannels: 2,
          outputFormat: "32-bit float", blockUs: 180, blockBudgetUs: 10000, blocks: diagnosticCalls * 50,
          bufferStarvations: 0, normalizationGain: 0.708, preampGain: 1, postGain: 0.89, volume: 0.7,
          eqEnabled: true, limiterEnabled: true, crossfading: false,
          source: { kind: diagnosticSource, downloadedBytes: 2097152 + diagnosticCalls * 262144, totalBytes: 10485760, complete: diagnosticSource === "cache", failed: false } }
      }
      if (command === "audio_get_waveform") return []
      if (command === "get_image_cache_info")
        return { files: 0, bytes: 0, max_files: 4096, max_bytes: 536870912 }
      if (command === "get_media_ramps") return null
      if(command==="download_entity_status")return args.entities.map((item:any)=>({...item,known:true,total:12,downloaded:11,pending:0,failed:1,requested:true,error:"The audio file contains damaged frames."}))
      if(command==="download_entity_issues")return {total:1,items:[{trackId:42,title:"Evening Static",artist:"Fixture Artist",error:"The audio file contains damaged frames. Check the file in Plex or choose another version."}]}
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
    name: "Plex",
    cacheScope: "synthetic-visual-library",
    capabilities: {
      radio: true,
      sonicSimilarity: true,
      tags: true,
      playlists: true,
      playlistCreate: true,
      playlistEdit: true,
      djModes: true,
      lyrics: true,
      ratings: true,
      ...(discovery ? { mixTracks: true, stations: true } : {}),
    },
    getArtist: async () => { await loadingGate; return artist },
    getAllArtists: async (offset = 0, limit = 200) => ({ items: [artist].slice(offset, offset + limit), total: 1, offset }),
    getAllAlbums: async (offset = 0, limit = 200) => ({ items: albums.slice(offset, offset + limit), total: albums.length, offset }),
    getAllTracks: async (offset = 0, limit = 200) => ({ items: tracks.slice(offset, offset + limit), total: tracks.length, offset }),
    getArtistAlbums: async () => albums,
    getArtistPopularTracks: async () => tracks,
    getArtistSimilar: async () => [artist],
    getRelatedHubs: async () => [],
    getSectionStations: async () => [{ identifier: 'library.stations', items: ['Library Radio', 'Deep Cuts Radio', 'Time Travel Radio', 'Random Album Radio'].map((title, index) => ({ ...playlists[0], id: `fixture-station-${index}`, providerKey: `fixture-station-${index}`, title })) }],
    buildRadioUri: (key: string) => 'synthetic://radio/' + key,
    getAlbum: async () => { await loadingGate; return album },
    getAlbumTracks: async () => tracks,
    getTrack: async (id: string) => {
      if (id.startsWith("ytmusic:")) youtubeMetadataCalls.push(id)
      return ({ ...tracks.find(t => t.id === id)!,
      bitDepth: 24, samplingRate: 44100, channels: 2, gain: -3.4,
      albumGain: -3.4, loudness: -15, peak: 0.965,
      mediaInfo: { fileSize: 9200000, container: "m4a" },
      _providerData: { media: [{ parts: [{ file: "/synthetic/An exceptionally long directory name/An exceptionally long album name/Opening Track.m4a" }] }] },
    }) },
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
  let indexInfo: import("../../../src/matching/types").MatchingStatus = { paused:false,epoch:0,revision:1,tasks:[
    { kind:"artist",phase:"complete",offset:0,total:8306,started:1700000000000,completed:1700000010000,count:8306,requests:34,bytes:1000000,error:null,retryAt:0 },
    { kind:"album",phase:"verify",offset:10000,total:87130,started:1700000000000,completed:null,count:87130,requests:180,bytes:10000000,error:null,retryAt:0 },
    { kind:"track",phase:"scan",offset:20000,total:377386,started:1700000000000,completed:null,count:20000,requests:40,bytes:9000000,error:null,retryAt:0 },
  ], health: {lastCheck:1700000010000,pending:12,reconciliationPending:true,error:null,filters:{},refreshes:[{kind:"artist",watermark:1700000010,lastChecked:1700000010000,active:false,error:null}]} }
  const indexActions: string[] = []
  Object.assign(provider, {
    matchingIndexStatus: async () => structuredClone(indexInfo),
    matchingIndexControl: async (action:string) => {
      indexActions.push(action)
      indexInfo = { ...indexInfo,epoch:indexInfo.epoch+1,paused:action==="pause"||action==="clear",tasks:action==="clear"?[]:indexInfo.tasks }
      return structuredClone(indexInfo)
    },
  })
  w.fixtureMatchingIndex = { actions: () => indexActions }
  const pageRequests: { kind: string; offset: number; limit: number }[] = []
  const syntheticTrack = (index: number) => ({ ...tracks[0], id: String(100000 + index), title: `Synthetic song ${String(index).padStart(5, "0")}`, playlistItemId: String(index + 1), type: "track" as const })
  if (virtual) Object.assign(provider, {
    cacheScope: "virtual-stress",
    getRatedItemsPage: async (kind: string, offset: number, limit: number) => {
      pageRequests.push({ kind, offset, limit }); await loadingGate
      const total = kind === "track" ? 20000 : 6000
      return { items: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => kind === "track" ? syntheticTrack(offset + i) : kind === "album" ? { ...album, id: String(offset + i), title: `Synthetic album ${offset + i}`, type: "album" } : { ...artist, id: String(offset + i), title: `Synthetic artist ${offset + i}`, type: "artist" }), total, offset }
    },
    getPlaylistItems: async (_id: string, offset = 0, limit = 100) => {
      pageRequests.push({ kind: "playlist", offset, limit }); await loadingGate
      return { items: Array.from({ length: Math.min(limit, 20000 - offset) }, (_, i) => syntheticTrack(offset + i)), total: 20000, offset }
    },
    getMixTracksPage: async (_id: string, offset: number, limit: number) => {
      pageRequests.push({ kind: "mix", offset, limit }); await loadingGate
      return { items: Array.from({ length: Math.min(limit, 20000 - offset) }, (_, i) => syntheticTrack(offset + i)), total: 20000, offset }
    },
    favorites: { cachedTracks: async (ids: string[]) => { pageRequests.push({ kind: "favorites", offset: Number(ids[0]) - 100000, limit: ids.length }); await loadingGate; return ids.map(id => syntheticTrack(Number(id) - 100000)) } },
    getTrack: async (id: string) => syntheticTrack(Number(id) - 100000),
    getPlaybackInfo: async (track: any) => ({ url: "synthetic://music", trackKey: Number(track.id), partId: 1, parentKey: "synthetic", startRamp: null, endRamp: null }),
    reportProgress: async () => {},
    getLyrics: async () => [],
  })
  if(informationProof){provider.cacheScope=`plex-${"a".repeat(64)}`;playlists[0].id="123";playlists[0].title="The weekend collection";playlists[0].summary="A handpicked collection for the weekend.";useCatalogueStore.getState().activate({connectionRevision:1,cacheScope:provider.cacheScope})}
  if (queueProof) provider.savedQueue = {
    load: async () => JSON.parse(localStorage.getItem("synthetic-queue") ?? "null"),
    save: async (snapshot: any) => { localStorage.setItem("synthetic-queue", JSON.stringify(snapshot)) },
    position: async (state: any) => { const snapshot=JSON.parse(localStorage.getItem("synthetic-queue")??"null"); if(snapshot)localStorage.setItem("synthetic-queue",JSON.stringify({...snapshot,state})) },
    clear: async () => { localStorage.removeItem("synthetic-queue") },
  }
  await useLibraryStore.getState().activateProvider(provider)
  await activateMetadataCache(provider)
  useProviderStore.getState().setProvider(provider)
  if (params.has("matching-consumers")) {
    const { installMatchingConsumers } = await import("./matchingConsumers")
    installMatchingConsumers(provider, artist, album, tracks[0])
  }
  useLibraryStore.setState({
    playlists: virtual ? Array.from({ length: 3000 }, (_, i) => ({ ...playlists[0], id: `stress-${i}`, title: `Synthetic playlist ${i}`, trackCount: 20000, smart: true })) : playlists,
    likedTracks: tracks,
    likedAlbums: albums,
    likedArtists: [artist],
    _playlistsFetchedAt: Date.now(),
  })
  if (virtual) {
    useUIStore.setState({ deduplicateAlbums: false })
    const entries = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`favorite-${i}`, { id: `favorite-${i}`, key: `local:${100000+i}`, title: syntheticTrack(i).title, artist: tracks[0].artistName, album: tracks[0].albumName, durationMs: 180000, localTrackIds: [String(100000+i)], liked: true, explicit: true, sources: {}, changedAt: 1800000000000-i*1000, likedAt: 1800000000000-i*1000 }]))
    useFavoritesStore.setState({ collection: { ...emptyFavorites(), ratingsImported: true, entries }, loaded: true, loading: false, error: null, likedTrackIds: new Set(Object.keys(entries).map((_key,i) => String(100000+i))) })
    w.fixtureVirtual = { requests: () => pageRequests, clear: () => { pageRequests.length = 0 }, syncFavorite: (index: number) => {
      const state = useFavoritesStore.getState().collection
      const id = `favorite-${index}`
      useFavoritesStore.setState({ collection: { ...state, revision: state.revision + 1, entries: { ...state.entries, [id]: { ...state.entries[id], likedAt: Date.now() + 200000000000, changedAt: Date.now() } } } })
    } }
  }
  const noop = () => {}
  const interactions: { action: string; id?: string; position?: number }[] = []
  const playlistDrops: { id: string; ids: string[] }[] = []
  w.fixturePlaylistDrops = () => playlistDrops
  w.fixtureLoading = {
    hold: async (refresh = false) => {
      releaseLoading?.()
      loadingGate = new Promise<void>(resolve => { releaseLoading = resolve })
      await clearMetadataCache()
      usePodcastStore.setState({ feedCache: {}, topChartCache: {} })
      useLibraryStore.setState({ playlistItemsCache: {}, playlistIsFullyLoaded: {} })
      if (refresh) useUIStore.getState().incrementPageRefreshKey()
    },
    release: () => { releaseLoading?.(); releaseLoading = null; loadingGate = Promise.resolve() },
  }
  engine.setVisualizerEnabled = noop
  const realPlayer = usePlayerStore.getState()
  if (virtual) {
    w.fixtureVirtual.audioPlayCount = 0
    engine.play = async () => { w.fixtureVirtual.audioPlayCount++ }
    engine.beginSelection = noop
    engine.preloadNext = async () => {}
    engine.clearPreload = noop
    engine.stop = noop
  }
  useEqStore.setState({ syncToEngine: noop })
  useAudioSettingsStore.setState({ syncToEngine: async () => {} })
  useDeviceStore.setState({ initDeviceTracking: noop, dispose: noop })
  usePlayerStore.setState({
    playTrack: async (track) => {
      interactions.push({ action: "play", id: track.id })
    },
    playFromUri: async () => {},
    playPlaylist: async () => {},
    ...(virtual ? { playPagedTracks: async (source: any, _title: string, _href: string, shuffle: boolean, index = 0) => {
      await realPlayer.playPagedTracks(source, _title, _href, shuffle, index)
      const current=usePlayerStore.getState()
      w.fixtureVirtual.playback = { total: current.queue.length, shuffle, index: current.queueIndex, ids: current.queue.slice(0,500).map((track: any) => track.id) }
    } } : {}),
    playRadio: async (...args: any[]) => { (w.fixtureRadioCalls ??= []).push(args) },
    addToQueue: (items) => {
      interactions.push({ action: "queue", id: items[0]?.id })
    },
    jumpToQueueItem: (index) => {
      if (virtual) realPlayer.jumpToQueueItem(index)
      else interactions.push({ action: "jump", id: tracks[index]?.id })
    },
    currentTrack: actualPlayer && !virtual ? tracks[0] : null,
    queue: virtual ? [] : tracks,
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
  if (virtual) Object.assign(w.fixtureVirtual, {
    reviewLikes: () => { const collection=useFavoritesStore.getState().collection; useFavoritesStore.setState({collection:{...collection,settings:{...collection.settings,lastfm:true}},issues:{lastfm:"A saved change needs review"}}) },
    queue: () => { const player=usePlayerStore.getState(); return { total:player.queue.length,index:player.queueIndex,id:player.currentTrack?.id,position:player.positionMs,playing:player.isPlaying,error:player.playerError } },
    rememberPosition: async (positionMs: number) => { usePlayerStore.setState({ positionMs,isPlaying:false }); await flushQueuePersistence() },
  })
  if (queueProof) initializeQueuePersistence()
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
    playlistManagement: async () => {
      youtubeArtistEnabled = true
      useYoutubeMusicDiscoveryStore.setState({ connected: true, accountId: "fixture-youtube-owner" })
      const draft = (id: string, title: string) => newDraft({ title, description: "Synthetic playlist for merge review", artwork: null, external: defaultPlaylistSync() }, id)
      const first = { ...draft("mixed:merge-first", "First collection"), owners: { plex: provider.cacheScope }, automatic: false,
        items: tracks.slice(0, 3).map(track => newOccurrence(track, 100)) }
      const second = { ...draft("mixed:merge-second", "Second collection"), owners: { plex: provider.cacheScope }, automatic: false,
        items: tracks.slice(2, 5).map(track => newOccurrence(track, 200)) }
      const linked = { ...draft("mixed:badge-both", "Linked Plex and YouTube playlist with an exceptionally long title"), owners: { plex: provider.cacheScope, ytmusic: "fixture-youtube-owner" },
        providers: { plex: { id: "badge-plex", readOnly: false }, ytmusic: { id: "VLPLbadge", readOnly: false } }, automatic: false }
      const youtube = { ...draft("mixed:badge-youtube", "YouTube Music collection"), owners: { ytmusic: "fixture-youtube-owner" }, providers: { ytmusic: { id: "VLPLbadge2", readOnly: false } }, automatic: false }
      for (const item of [first, second, linked, youtube]) await mixedPlaylistRepository.save(item)
      await useMixedPlaylistStore.getState().load()
      const remote = new Map<string, any>()
      Object.assign(provider, {
        createPlaylist: async (title: string) => {
          const created = { ...playlists[0], id: `fixture-created-${remote.size}`, title, trackCount: 0 }
          playlists.push(created); remote.set(created.id, { title, items: [] }); return created
        },
        mutatePlaylistOccurrence: async (id: string, _before: unknown, operation: any) => {
          const list = remote.get(id)
          if (operation.kind === "append") list.items.push({ ...tracks.find(track => track.id === operation.trackId), playlistItemId: `handle-${list.items.length}` })
          else if (operation.kind === "appendMany") for (const trackId of operation.trackIds) list.items.push({ ...tracks.find(track => track.id === trackId), playlistItemId: `handle-${list.items.length}` })
          else if (operation.kind === "delete") list.items.splice(operation.index, 1)
          else list.items.splice(operation.to, 0, list.items.splice(operation.from, 1)[0])
        },
        getPlaylistItems: async (id: string, offset = 0, limit = 100) => ({ items: (remote.get(id)?.items ?? tracks).slice(offset, offset + limit), total: remote.get(id)?.items.length ?? tracks.length, offset }),
        editPlaylist: async (id: string, title: string, summary: string) => { const item = playlists.find(item => item.id === id); if (item) Object.assign(item, { title, summary }) },
      })
    },
    mixedSyncProgress: (phase: "admitted" | "verified" | "unknown" | "complete") => {
      const items = Array.from({ length: 307 }, (_, index) => {
        const row = newOccurrence({ ...tracks[index % tracks.length], id: String(10000 + index) }, 100)
        row.id = `sync-occurrence-${index}`
        if (index < 3) row.songs.ytmusic = { track: youtubeMusicTrack({ videoId: `a123456789${index}`, title: row.songs.plex!.track.title, artist: "Fixture Artist", album: "Fixture Album", duration: "3:14", thumbnail: null }) }
        row.match = { status: index < 3 ? "matched" : "missing", policy: COUNTERPART_POLICY, checkedAt: 100 }
        return row
      })
      const before = { service: "plex" as const, owner: provider.cacheScope, id: "sync-progress", title: "Merged playlist sync", readOnly: false,
        items: items.slice(0, phase === "verified" || phase === "complete" ? 307 : 14).map((row, index) => ({ track: row.songs.plex!.track, occurrenceId: `plex-${index}` })) }
      const playlist = { ...newDraft({ title: before.title, description: "", artwork: null, external: defaultPlaylistSync() }, "mixed:sync-progress"),
        owners: { plex: provider.cacheScope, ytmusic: "fixture-youtube-owner" }, automatic: true, items,
        merge: { sources: [], duplicates: "verified" as const, reviewedAt: 1 },
        providers: { plex: { id: before.id, readOnly: false } }, baseline: { plex: before },
        message: "304 unmatched songs retained in Hibiki.", status: phase === "unknown" ? "error" as const : "ready" as const,
        write: phase === "admitted" || phase === "unknown" ? { id: "progress-receipt", service: "plex" as const, kind: "append" as const,
          before, afterIds: items.map(row => row.songs.plex!.track.id), state: phase === "unknown" ? "unknown" as const : "admitted" as const } : undefined }
      useYoutubeMusicDiscoveryStore.setState({ connected: true, accountId: "fixture-youtube-owner" })
      useMixedPlaylistStore.setState({ loaded: true, playlists: [playlist], running: { [playlist.id]: phase === "admitted" || phase === "verified" }, load: async () => {} })
    },
    drafts: {
      disconnect: () => { useProviderStore.setState({ provider: null }); useYoutubeMusicDiscoveryStore.setState({ connected: false, accountId: null }) },
      snapshot: () => useMixedPlaylistStore.getState().playlists.filter(item => item.local),
      reload: async () => { useMixedPlaylistStore.setState({ playlists: [], loaded: false }); await useMixedPlaylistStore.getState().load() },
      writes: () => w.fixturePlaylistWrites ?? [],
      radioCalls: () => w.fixtureRadioCalls ?? [],
    },
    likedPreview: () => {
      youtubeLikesEnabled = true
      useUIStore.setState({ isQueueOpen: false, isQueuePinned: false })
      useFavoritesStore.setState({ collection: { ...emptyFavorites(), ratingsImported: true, entries: {
        "fixture-like": { id: "fixture-like", key: `local:${tracks[0].id}`, title: tracks[0].title, artist: tracks[0].artistName,
          album: tracks[0].albumName, durationMs: tracks[0].duration, localTrackIds: [tracks[0].id], liked: true, explicit: true, sources: {}, changedAt: 1, likedAt: 1 },
      } }, loaded: true, loading: false, error: null })
      useYoutubeMusicRatingsStore.setState({ owner: "fixture-youtube-owner", loaded: true, entries: {} })
      usePlayerStore.setState({ playPagedTracks: async source => {
        w.fixtureLikedPlayback = (await source.loadPage(0, source.total!)).items.map(track => track.id)
      } })
    },
    mixedPreview: () => {
      const youtube = { ...youtubeMusicTrack({ videoId: "abcdefghijk", title: "YouTube playlist song", artist: "Fixture Artist", album: "Fixture Album", duration: "3:14", thumbnail: null }), thumbUrl: thumb }
      const initial = hydratePlaylist({ service: "plex", owner: provider.cacheScope, id: playlists[0].id, title: "Plex + YTM playlist",
        readOnly: false, items: tracks.slice(0, 2).map((track, index) => ({ track, occurrenceId: `fixture-${index}` })) })
      const pending = { ...newOccurrence(youtube), match: { status: "missing" as const, message: "No verified Plex recording found. The original song is retained." } }
      const playlist = { ...initial, id: "mixed:fixture", owners: { plex: provider.cacheScope, ytmusic: "fixture-youtube-owner" },
        automatic: false, items: [initial.items[0], pending, initial.items[1]], message: "1 unmatched song retained in Hibiki." }
      useYoutubeMusicDiscoveryStore.setState({ connected: true, accountId: "fixture-youtube-owner" })
      useMixedPlaylistStore.setState({ loaded: true, playlists: [playlist], load: async () => {} })
      useYoutubeMusicRatingsStore.setState({ owner: "fixture-youtube-owner", loaded: true, entries: {
        [youtube.id]: { id: "fixture-rating", owner: "fixture-youtube-owner", track: youtube, value: 4, changedAt: 1, saved: { ytmusic: "fixture-youtube-owner" } },
      } })
      usePlayerStore.setState({ currentTrack: tracks[0], queue: [tracks[0], youtube, tracks[1]], queueIndex: 0 })
    },
    youtubePreview: (mode: "playing" | "saved" | "cache" | "plex" = "playing") => {
      const song = (videoId: string, title: string) => ({ ...youtubeMusicTrack({
        videoId, title, artist: "Fixture Artist", album: "Fixture Album", duration: "3:14", thumbnail: null,
      }), thumbUrl: thumb, albumThumbUrl: thumb })
      const current = song("abcdefghijk", "YouTube fixture song with a long title")
      const cold = { ...song("lmnopqrstuv", "Saved upcoming song"), streamUrl: null }
      diagnosticSource = mode === "cache" ? "cache" : "network"
      usePlayerStore.setState({
        currentTrack: mode === "plex" ? tracks[0] : current,
        queue: [song("ZYXWVUTSRQP", "Previously played song"), current, tracks[1], cold],
        queueIndex: 1, isPlaying: mode !== "saved", repeat: 0,
        playbackFormat: mode === "saved" || mode === "plex" ? null : {
          trackId: current.id, playbackId: 1,
          format: { codec: "AAC", bit_depth: null, sample_rate: 44100, channels: 2 },
        },
      })
    },
    youtubeMetadataCalls: () => youtubeMetadataCalls,
    liked: (id: string, liked: boolean) => {
      const ids = new Set(useFavoritesStore.getState().likedTrackIds)
      if (liked) ids.add(id); else ids.delete(id)
      useFavoritesStore.setState({ provider: provider as any, session: (provider as any).playbackSession, loaded: true, likedTrackIds: ids })
    },
    radioPreview: () => usePlayerStore.setState({ isRadioMode: true, radioType: "artist", radioSeedArtist: "The Midnight Ensemble", contextName: "A long synthetic radio station name Radio" }),
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
      youtubeArtistEnabled = youtubeLikesEnabled || path.startsWith("/ytmusic/") || path.startsWith("/mixed-playlist/")
      useYoutubeMusicDiscoveryStore.setState({ connected: youtubeArtistEnabled, accountId: youtubeArtistEnabled ? "fixture-youtube-owner" : null })
      history.pushState({}, "", path)
      dispatchEvent(new PopStateEvent("popstate"))
    },
    interactions: () => interactions,
    playingFormat: (format: any) => usePlayerStore.setState({ playbackFormat: { trackId: usePlayerStore.getState().currentTrack!.id, playbackId: 1, format } }),
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
      useUIStore.getState().incrementPageRefreshKey()
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
    let notificationSeed = 0, failureEvent = 0
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
        notificationSeed++
        const center = useNotificationCenterStore.getState()
        center.notify({
          id: "fixture-info",
          title: "Fixture refresh finished",
          message: "Your synthetic library is up to date.",
          severity: "success",
        })
        center.notify({...warning(),eventKey:`seed-${notificationSeed}`})
        center.notify({
          id: "fixture-error",
          title: "Fixture decoder message",
          message:
            "This is an intentionally long synthetic diagnostic: " +
            "LongUnbrokenDiagnostic".repeat(10),
          severity: "error",
          eventKey: `seed-${notificationSeed}`,
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
        useNotificationCenterStore.getState().notify({...warning(),eventKey:`failure-${++failureEvent}`})
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
        React.createElement(SideBar, { onCreatePlaylist: () => useUIStore.getState().setShowCreatePlaylist(true) }),
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
  const createOpen = useUIStore(state => state.showCreatePlaylist)
  return (
    <ArtworkShell>
      {children}
      <ContextMenu />
      <HoverInformation />
      {createOpen && <CreatePlaylist onClose={() => useUIStore.getState().setShowCreatePlaylist(false)} />}
      {hotkeyHelpOpen && <HotkeyHelpModal context="visualizer" onClose={() => setHotkeyHelpOpen(false)} />}
    </ArtworkShell>
  )
}
