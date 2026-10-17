import { Link, Redirect, Route, useLocation, useRouter } from "wouter"
import { useLayoutEffect, useRef } from "react"
import { ScrollContainerContext } from "../lib/scrollContainer"
export {
  ScrollContainerContext,
  useScrollContainer,
} from "../lib/scrollContainer"
import { Playlist } from "./Pages/Playlist"
import { Home } from "./Pages/Home"
import { Library } from "./Pages/Library"
import { ArtistPage } from "./Pages/Artist"
import { AlbumPage } from "./Pages/Album"
import { Liked } from "./Pages/Liked"
import { LikedArtists } from "./Pages/LikedArtists"
import { LikedAlbums } from "./Pages/LikedAlbums"
import { SettingsPage } from "./Pages/Settings"
import { RadioPage } from "./Pages/Radio"
import { MixPage } from "./Pages/Mix"
import { StationsPage } from "./Pages/Stations"
import { HubPage } from "./Pages/HubPage"
import { RecentlyAddedPage } from "./Pages/RecentlyAddedPage"
import { TagPage } from "./Pages/TagPage"
import { InternetRadioPage } from "./Pages/InternetRadio"
import { PodcastsPage } from "./Pages/Podcasts"
import { decodePodcastFeed, PODCAST_ROUTE } from "../lib/podcastRoute"
import { libraryRouteSegment } from "../lib/libraryRoute"
import { PodcastDetailPage } from "./Pages/PodcastDetail"
import { Playlists } from "./Pages/Playlists"
// MixPage uses module-level selectMix() state — no URL param needed
import clsx from "clsx"
import { TopBar } from "./TopBar"
import { Search } from "./Pages/Search"
import { PlexOfflineBanner } from "./OfflineStatus"

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
            "app-page-content scrollbar-thumb-(--scrollbar-thumb) hover:scrollbar-thumb-(--scrollbar-thumb-hover) flex-1 overflow-auto border-(--border) transition-colors scrollbar scrollbar-track-transparent scrollbar-track-rounded-lg scrollbar-w-3"
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
          <Route path="/downloads">
            <Redirect to="/settings/cache" />
          </Route>

          <Route path="/playlist/:id" key="playlist">
            {(params: { id?: string }) => {
              const id = params.id ?? ""
              return id ? <Playlist playlistId={id} /> : null
            }}
          </Route>

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

          <Route path="/hub/:hubId" key="hub">
            {() => {
              const hub = libraryRouteSegment(rawLocation, `${routeBase}/hub/`)
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
        </div>
      </div>
    </ScrollContainerContext.Provider>
  )
}
