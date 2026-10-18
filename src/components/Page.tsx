import { Link, Redirect, Route, useLocation, useRouter } from "wouter"
import { lazy, Suspense, useLayoutEffect, useRef } from "react"
import { PageLoading } from "./shared/PageLoading"
import { ScrollContainerContext } from "../lib/scrollContainer"
export {
  ScrollContainerContext,
  useScrollContainer,
} from "../lib/scrollContainer"
import { Home } from "./Pages/Home"
import { decodePodcastFeed, PODCAST_ROUTE } from "../lib/podcastRoute"
import { libraryRouteSegment } from "../lib/libraryRoute"
// MixPage uses module-level selectMix() state — no URL param needed
import clsx from "clsx"
import { TopBar } from "./TopBar"
import { PlexOfflineBanner } from "./OfflineStatus"

const Playlist = lazy(() =>
  import("./Pages/Playlist").then((module) => ({ default: module.Playlist }))
)
const MixedPlaylist = lazy(() => import("./Pages/MixedPlaylist").then(module => ({ default: module.MixedPlaylist })))
const ServerLibraryOverview = lazy(() => import("./Pages/ServerLibraryOverview").then(module => ({ default: module.ServerLibraryOverview })))
const Library = lazy(() =>
  import("./Pages/Library").then((module) => ({ default: module.Library }))
)
const ArtistPage = lazy(() =>
  import("./Pages/Artist").then((module) => ({ default: module.ArtistPage }))
)
const AlbumPage = lazy(() =>
  import("./Pages/Album").then((module) => ({ default: module.AlbumPage }))
)
const Liked = lazy(() =>
  import("./Pages/Liked").then((module) => ({ default: module.Liked }))
)
const LikedArtists = lazy(() =>
  import("./Pages/LikedArtists").then((module) => ({
    default: module.LikedArtists,
  }))
)
const LikedAlbums = lazy(() =>
  import("./Pages/LikedAlbums").then((module) => ({
    default: module.LikedAlbums,
  }))
)
const SettingsPage = lazy(() =>
  import("./Pages/Settings").then((module) => ({
    default: module.SettingsPage,
  }))
)
const RadioPage = lazy(() =>
  import("./Pages/Radio").then((module) => ({ default: module.RadioPage }))
)
const MixPage = lazy(() =>
  import("./Pages/Mix").then((module) => ({ default: module.MixPage }))
)
const StationsPage = lazy(() =>
  import("./Pages/Stations").then((module) => ({
    default: module.StationsPage,
  }))
)
const HubPage = lazy(() =>
  import("./Pages/HubPage").then((module) => ({ default: module.HubPage }))
)
const YoutubeMusicCollection = lazy(() =>
  import("./Pages/YoutubeMusicCollection").then(module => ({ default: module.YoutubeMusicCollection }))
)
const RecentlyAddedPage = lazy(() =>
  import("./Pages/RecentlyAddedPage").then((module) => ({
    default: module.RecentlyAddedPage,
  }))
)
const TagPage = lazy(() =>
  import("./Pages/TagPage").then((module) => ({ default: module.TagPage }))
)
const InternetRadioPage = lazy(() =>
  import("./Pages/InternetRadio").then((module) => ({
    default: module.InternetRadioPage,
  }))
)
const PodcastsPage = lazy(() =>
  import("./Pages/Podcasts").then((module) => ({
    default: module.PodcastsPage,
  }))
)
const PodcastDetailPage = lazy(() =>
  import("./Pages/PodcastDetail").then((module) => ({
    default: module.PodcastDetailPage,
  }))
)
const Playlists = lazy(() =>
  import("./Pages/Playlists").then((module) => ({ default: module.Playlists }))
)
const Search = lazy(() =>
  import("./Pages/Search").then((module) => ({ default: module.Search }))
)
const ServerLibrary = lazy(() => import("./Pages/ServerLibrary").then(module => ({ default: module.ServerLibrary })))

// Module-level map — persists for the app lifetime.
const verticalScrollPositions = new Map<string, number>()

/**
 * Provides the main scroll container ref to nested page components.
 * Pass the ref OBJECT (not ref.current) so children can read .current
 * inside their useEffect hooks after the DOM has been committed.
 */

const bg = {
  home: "bg-linear-to-b from-(--bg-elevated) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  search:
    "bg-linear-to-b from-(--bg-base) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  library:
    "bg-linear-to-b from-(--bg-base) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  collection:
    "bg-linear-to-b from-(--bg-elevated) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  playlist:
    "bg-linear-to-b from-(--bg-base) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  "mixed-playlist":
    "bg-linear-to-b from-(--bg-base) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  artist:
    "bg-linear-to-b from-(--bg-base) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  album:
    "bg-linear-to-b from-(--bg-base) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  stations:
    "bg-linear-to-b from-(--bg-base) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  radio:
    "bg-linear-to-b from-(--bg-base) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  "internet-radio":
    "bg-linear-to-b from-(--bg-base) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  podcasts:
    "bg-linear-to-b from-(--bg-base) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  podcast:
    "bg-linear-to-b from-(--bg-base) from-10% via-(--bg-base) via-40% to-(--bg-base) to-90%",
  settings: "bg-(--bg-base)",
}

const NO_PADDING_ROUTES = new Set([
  "playlist",
  "mixed-playlist",
  "ytmusic",
  "mix",
  "artist",
  "album",
  "collection",
  "settings",
  "internet-radio",
  "podcasts",
  "podcast",
])

export function Page() {
  const [location] = useLocation()
  const router = useRouter()
  // Matched params have already passed through decodeURI. Keep the original
  // router location for one component decode, including custom location hooks.
  const [rawLocation] = router.hook(router)
  const routeBase = router.base === "/" ? "" : router.base
  const invalidLibraryLink = (
    <div role="alert" className="p-8 text-gray-400">
      Invalid library link.{" "}
      <Link href="/library" className="text-white underline">
        Browse your library
      </Link>
    </div>
  )
  const baseLoc = location.split("/")[1]?.split("?")[0]
  const scrollRef = useRef<HTMLDivElement>(null)

  const bgClass = bg[baseLoc as keyof typeof bg] || bg["home"]
  const hasPadding = !NO_PADDING_ROUTES.has(baseLoc)
  const isHome = baseLoc === "" || baseLoc === "index.html"

  // Restore scroll before the browser paints (no flash at position 0).
  // The content is already committed to the DOM when useLayoutEffect runs,
  // so scrollTop lands correctly even for tall cached pages.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = verticalScrollPositions.get(location) ?? 0
  }, [location])

  return (
    // Pass the ref object (stable identity) — children read .current in their effects.
    <ScrollContainerContext.Provider value={scrollRef}>
      <div className={clsx("app-page flex h-full flex-col", bgClass)}>
        <TopBar />
        <PlexOfflineBanner />

        <div
          ref={scrollRef}
          onScroll={(e) =>
            verticalScrollPositions.set(location, e.currentTarget.scrollTop)
          }
          className={clsx(
            "app-page-content scrollbar scrollbar-track-rounded-lg scrollbar-w-3 flex-1 scrollbar-thumb-(--scrollbar-thumb) scrollbar-track-transparent overflow-auto border-(--border) transition-colors hover:scrollbar-thumb-(--scrollbar-thumb-hover)"
          )}
          style={
            hasPadding
              ? {
                  paddingInline: "var(--spacing-topbar)",
                  paddingBlock: isHome
                    ? "calc(var(--spacing-topbar) * 0.75)"
                    : "var(--spacing-topbar)",
                }
              : undefined
          }
        >
          <Suspense
            fallback={
              <PageLoading message="Loading this page…" variant="grid" />
            }
          >
            <Route path="/" key="home">
              <Home />
            </Route>

            <Route path="/index.html" key="index">
              <Home />
            </Route>

            <Route path="/search" key="search">
              <Search />
            </Route>

            <Route path="/library" key="library">
              <Library />
            </Route>
            <Route path="/server-library" key="server-library-overview"><ServerLibraryOverview /></Route>
            <Route path="/server-library/:kind" key="server-library">
              {(params: { kind?: string }) => params.kind === "artists" || params.kind === "albums" || params.kind === "songs"
                ? <ServerLibrary kind={params.kind} /> : invalidLibraryLink}
            </Route>
            <Route path="/downloads">
              <Redirect to="/settings/cache" />
            </Route>

            <Route path="/playlist/:id" key="playlist">
              {(params: { id?: string }) => {
                const id = params.id ?? ""
                return id ? <Playlist playlistId={id} /> : null
              }}
            </Route>
            <Route path="/mixed-playlist/:id" key="mixed-playlist">{() => {
              const id = libraryRouteSegment(rawLocation, `${routeBase}/mixed-playlist/`)
              return id ? <MixedPlaylist id={id} /> : invalidLibraryLink
            }}</Route>

            <Route path="/mix" key="mix">
              <MixPage />
            </Route>

            <Route path="/artist/:id" key="artist">
              {(params: { id?: string }) => {
                const id = params.id ?? ""
                return id ? <ArtistPage artistId={id} /> : null
              }}
            </Route>

            <Route path="/collection/playlists" key="playlists">
              <Playlists />
            </Route>

            <Route path="/collection/tracks" key="liked">
              <Liked />
            </Route>

            <Route path="/collection/artists" key="liked-artists">
              <LikedArtists />
            </Route>

            <Route path="/collection/albums" key="liked-albums">
              <LikedAlbums />
            </Route>

            <Route path="/stations" key="stations">
              <StationsPage />
            </Route>

            <Route path="/internet-radio" key="internet-radio">
              <InternetRadioPage />
            </Route>

            <Route path="/podcasts" key="podcasts">
              <PodcastsPage />
            </Route>

            <Route path={PODCAST_ROUTE} key="podcast">
              {(params: { encoded?: string }) => {
                const url = decodePodcastFeed(params.encoded)
                return url ? (
                  <PodcastDetailPage feedUrl={url} />
                ) : (
                  <div role="alert" className="p-8 text-gray-400">
                    Invalid podcast link.{" "}
                    <Link href="/podcasts" className="text-white underline">
                      Browse podcasts
                    </Link>
                  </div>
                )
              }}
            </Route>

            <Route path="/album/:id" key="album">
              {(params: { id?: string }) => {
                const id = params.id ?? ""
                return id ? <AlbumPage albumId={id} /> : null
              }}
            </Route>

            <Route path="/radio/:type" key="radio">
              {() => {
                const station = libraryRouteSegment(
                  rawLocation,
                  `${routeBase}/radio/`
                )
                return station ? (
                  <RadioPage stationType={station} />
                ) : (
                  invalidLibraryLink
                )
              }}
            </Route>

            <Route path="/settings/*?" key="settings">
              {(params: { "*"?: string }) => (
                <SettingsPage section={params["*"]} />
              )}
            </Route>

            <Route path="/ytmusic/:browseId" key="ytmusic">
              {() => {
                const id = libraryRouteSegment(rawLocation, `${routeBase}/ytmusic/`)
                return id ? id.startsWith("UC") ? <ArtistPage artistId={`ytmusic:${id}`} /> : <YoutubeMusicCollection browseId={id} /> : invalidLibraryLink
              }}
            </Route>

            <Route path="/hub/:hubId" key="hub">
              {() => {
                const hub = libraryRouteSegment(
                  rawLocation,
                  `${routeBase}/hub/`
                )
                return hub ? <HubPage hubId={hub} /> : invalidLibraryLink
              }}
            </Route>

            <Route path="/recently-added" key="recently-added">
              <RecentlyAddedPage />
            </Route>

            <Route path="/genre/:tagType/:tagName" key="genre">
              {(params: { tagType?: string; tagName?: string }) => {
                const t = params.tagType
                const n = libraryRouteSegment(
                  rawLocation,
                  `${routeBase}/genre/${t}/`
                )
                return (t === "genre" || t === "mood" || t === "style") && n ? (
                  <TagPage tagType={t} tagName={n} />
                ) : (
                  invalidLibraryLink
                )
              }}
            </Route>
          </Suspense>
        </div>
      </div>
    </ScrollContainerContext.Provider>
  )
}
