import { useMetadataIdentityStore } from "../src/stores/metadataIdentityStore"
import { resolve } from "node:path"
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  useAlbumArtwork,
  useArtistImage,
  useArtistArtwork,
  useArtistBackgroundArtwork,
  useAlbumBackgroundArtwork,
} from "../src/hooks/useMediaImage"
import { useMetadataSourceStore } from "../src/stores/metadataSourceStore"
import { useDeezerMetadataStore } from "../src/metadata/deezer/store"
import {
  useArtworkPreferenceStore,
  artworkPreferenceKey,
  artworkRevisionKey,
} from "../src/stores/artworkPreferenceStore"
import { useProviderStore } from "../src/stores/providerStore"
import { useHeyaArtworkStore } from "../src/metadata/heya/artworkStore"
import { useHeyaServiceStore } from "../src/metadata/services/store"
import { useFanartMetadataStore } from "../src/metadata/fanart/store"
import { useFanartServiceStore } from "../src/metadata/services/store"
import { useCoverArtArchiveMetadataStore } from "../src/metadata/coverartarchive/store"
import { useItunesMetadataStore } from "../src/metadata/apple/store"

const dom = new JSDOM("<div id='root'></div>")
const previous = {
  document: globalThis.document,
  window: globalThis.window,
  act: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
}
const heyaOriginal = useHeyaArtworkStore.getState()
const heyaServiceOriginal = useHeyaServiceStore.getState()
const fanartOriginal = useFanartMetadataStore.getState()
const fanartServiceOriginal = useFanartServiceStore.getState()
const candidateOriginal = useArtworkPreferenceStore.getState().candidateChoices
const deezerOriginal = useDeezerMetadataStore.getState()
const caaOriginal = useCoverArtArchiveMetadataStore.getState()
const appleOriginal = useItunesMetadataStore.getState()
const revisionOriginal = useArtworkPreferenceStore.getState().revisions
const preferenceOriginal = useArtworkPreferenceStore.getState().choices
const providerOriginal = useProviderStore.getState().provider
const priorityOriginal = useMetadataSourceStore.getState().priority
let root: Root
let requests: string[]
function Harness({
  artist = "Artist",
  plex = "plex-art",
  failures = [],
}: {
  artist?: string
  plex?: string | null
  failures?: string[]
}) {
  const albumInfo = useAlbumArtwork(artist, "Album", plex, "album-id", failures)
  const album = albumInfo.url
  const image = useArtistImage(artist, plex, "artist-id", failures)
  return (
    <output data-refresh-target={albumInfo.refreshTargets.apple ?? ""}>
      {JSON.stringify({ album, image })}
    </output>
  )
}
async function render(
  props: { artist?: string; plex?: string | null; failures?: string[] } = {}
) {
  await act(async () => {
    root.render(<Harness {...props} />)
  })
}
beforeEach(() => {
  useMetadataIdentityStore.setState({
    choices: {},
    versions: {},
    hydrated: true,
  })
  useHeyaServiceStore.setState({ status: null })
  useHeyaArtworkStore.setState({
    artists: {},
    albums: {},
    getArtist: async () => null,
    getAlbum: async () => null,
  })
  useFanartServiceStore.setState({ status: null })
  useFanartMetadataStore.setState({
    _hasHydrated: true,
    artists: {},
    albums: {},
    getArtist: async () => null,
    getAlbum: async () => null,
  })
  useArtworkPreferenceStore.setState({ candidateChoices: {} })
  useCoverArtArchiveMetadataStore.setState({
    _hasHydrated: true,
    albums: {},
    getAlbum: async () => null,
  })
  globalThis.document = dom.window.document
  globalThis.window = dom.window as unknown as Window & typeof globalThis
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  useArtworkPreferenceStore.setState({ choices: {}, revisions: {} })
  useProviderStore.setState({
    provider: { cacheScope: "synthetic-account-library-a" } as any,
  })
  requests = []
  useDeezerMetadataStore.setState({
    artists: {},
    albums: {},
    _hasHydrated: true,
    getArtist: async (name) => {
      requests.push(`deezer-artist:${name}`)
      return null
    },
    getAlbum: async (name) => {
      requests.push(`deezer-album:${name}`)
      return null
    },
  })
  useItunesMetadataStore.setState({
    albums: {},
    _hasHydrated: true,
    getAlbum: async (name) => {
      requests.push(`apple-album:${name}`)
      return null
    },
  })
  useMetadataSourceStore.setState({ priority: ["plex", "deezer", "apple"] })
  root = createRoot(document.getElementById("root")!)
})
afterEach(async () => {
  await act(() => root.unmount())
})
afterAll(() => {
  useHeyaServiceStore.setState(heyaServiceOriginal)
  useHeyaArtworkStore.setState(heyaOriginal)
  useFanartServiceStore.setState(fanartServiceOriginal)
  useFanartMetadataStore.setState(fanartOriginal)
  useCoverArtArchiveMetadataStore.setState(caaOriginal)
  useDeezerMetadataStore.setState(deezerOriginal)
  useItunesMetadataStore.setState(appleOriginal)
  useMetadataSourceStore.setState({ priority: priorityOriginal })
  useArtworkPreferenceStore.setState({
    choices: preferenceOriginal,
    candidateChoices: candidateOriginal,
    revisions: revisionOriginal,
  })
  useProviderStore.setState({ provider: providerOriginal })
  globalThis.document = previous.document
  globalThis.window = previous.window
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act
  dom.window.close()
})
test("available Plex art avoids lower-priority artwork requests", async () => {
  await render()
  expect(requests).toEqual([])
})
test("moving Apple above available Plex and Deezer art requests an upgrade", async () => {
  useDeezerMetadataStore.setState({
    albums: {
      "artist::album": {
        data: {
          artist: "Artist",
          title: "Album",
          cover_url: "https://fixture/deezer",
        } as any,
        cachedAt: Date.now(),
      },
    },
  })
  await render()
  await act(() =>
    useMetadataSourceStore.setState({ priority: ["apple", "plex", "deezer"] })
  )
  expect(requests).toEqual(["apple-album:Artist"])
  await act(() =>
    useItunesMetadataStore.setState({
      albums: {
        "artist::album": {
          data: {
            artist: "Artist",
            title: "Album",
            cover_url: "https://fixture/apple",
          } as any,
          cachedAt: Date.now(),
        },
      },
    })
  )
  expect(document.querySelector("output")!.textContent).toContain(
    "fixture%2Fapple"
  )
})
test("Deezer above Plex requests both album and artist upgrades", async () => {
  useMetadataSourceStore.setState({ priority: ["deezer", "plex", "apple"] })
  await render()
  expect(requests).toEqual(["deezer-album:Artist", "deezer-artist:Artist"])
})
test("missing artwork permits fallback requests and hydration gates them", async () => {
  useDeezerMetadataStore.setState({ _hasHydrated: false })
  useItunesMetadataStore.setState({ _hasHydrated: false })
  await render({ plex: null })
  expect(requests).toEqual([])
  await act(() => {
    useDeezerMetadataStore.setState({ _hasHydrated: true })
    useItunesMetadataStore.setState({ _hasHydrated: true })
  })
  expect(requests).toEqual([
    "deezer-album:Artist",
    "apple-album:Artist",
    "deezer-artist:Artist",
  ])
})
test("changing entity does not display the previous entity's external image", async () => {
  useMetadataSourceStore.setState({ priority: ["apple", "deezer", "plex"] })
  useItunesMetadataStore.setState({
    albums: {
      "artist::album": {
        data: {
          artist: "Artist",
          title: "Album",
          cover_url: "https://fixture/old",
        } as any,
        cachedAt: Date.now(),
      },
    },
  })
  await render()
  expect(document.querySelector("output")!.textContent).toContain(
    "fixture%2Fold"
  )
  await render({ artist: "Other", plex: "new-plex" })
  expect(document.querySelector("output")!.textContent).not.toContain(
    "fixture%2Fold"
  )
  expect(document.querySelector("output")!.textContent).toContain("new-plex")
})

test("failed Plex artwork enables the next preferred provider, then skips a failed Apple image", async () => {
  useMetadataSourceStore.setState({ priority: ["plex", "apple", "deezer"] })
  await render({ failures: ["plex-art"] })
  expect(requests).toContain("apple-album:Artist")
  expect(
    document.querySelector("output")!.getAttribute("data-refresh-target")
  ).toBe("")
  await act(() =>
    useItunesMetadataStore.setState({
      albums: {
        "artist::album": {
          data: {
            artist: "Artist",
            title: "Album",
            cover_url: "https://fixture/apple",
          } as any,
          cachedAt: Date.now(),
        },
      },
    })
  )
  const appleUrl = JSON.parse(
    document.querySelector("output")!.textContent!
  ).album
  expect(appleUrl).toContain("fixture%2Fapple")
  await render({ failures: ["plex-art", appleUrl] })
  expect(
    JSON.parse(document.querySelector("output")!.textContent!).album
  ).toBeNull()
  expect(requests).toContain("deezer-album:Artist")
})

test("per-item choices override automatic order across views and failed sources fall back without crossing account scopes", async () => {
  const scope = "synthetic-account-library-a"
  useDeezerMetadataStore.setState({
    artists: {
      artist: {
        data: { image_url: "https://fixture/artist" } as any,
        cachedAt: Date.now(),
      },
    },
  })
  useItunesMetadataStore.setState({
    albums: {
      "artist::album": {
        data: {
          artist: "Artist",
          title: "Album",
          cover_url: "https://fixture/apple",
        } as any,
        cachedAt: Date.now(),
      },
    },
  })
  useArtworkPreferenceStore
    .getState()
    .setChoice(artworkPreferenceKey(scope, "artist", "Artist")!, "deezer")
  useArtworkPreferenceStore
    .getState()
    .setChoice(
      artworkPreferenceKey(scope, "album", "Artist", "Album")!,
      "apple"
    )
  await render()
  let result = JSON.parse(document.querySelector("output")!.textContent!)
  expect(result.image).toContain("fixture%2Fartist")
  expect(result.album).toContain("fixture%2Fapple")
  await render({ artist: "ARTIST" })
  result = JSON.parse(document.querySelector("output")!.textContent!)
  expect(result.image).toContain("fixture%2Fartist")
  await render({ artist: "ARTIST", failures: [result.image, result.album] })
  result = JSON.parse(document.querySelector("output")!.textContent!)
  expect(result).toEqual({ album: "plex-art", image: "plex-art" })
  await act(() =>
    useProviderStore.setState({
      provider: { cacheScope: "synthetic-account-library-b" } as any,
    })
  )
  await render()
  expect(JSON.parse(document.querySelector("output")!.textContent!)).toEqual({
    album: "plex-art",
    image: "plex-art",
  })
  await act(() => {
    useProviderStore.setState({ provider: { cacheScope: scope } as any })
    useArtworkPreferenceStore
      .getState()
      .setChoice(artworkPreferenceKey(scope, "album", "Artist", "Album")!, null)
  })
  expect(JSON.parse(document.querySelector("output")!.textContent!).album).toBe(
    "plex-art"
  )
})
test("an explicit album choice cannot display cached artwork for a different edition", async () => {
  useArtworkPreferenceStore
    .getState()
    .setChoice(
      artworkPreferenceKey(
        "synthetic-account-library-a",
        "album",
        "Artist",
        "Album"
      )!,
      "apple"
    )
  useItunesMetadataStore.setState({
    albums: {
      "artist::album": {
        data: {
          artist: "Artist",
          title: "Different Album",
          cover_url: "https://fixture/unrelated",
        } as any,
        cachedAt: Date.now(),
      },
    },
  })
  await render()
  expect(JSON.parse(document.querySelector("output")!.textContent!).album).toBe(
    "plex-art"
  )
  expect(requests).toContain("apple-album:Artist")
})

test("a successful exact image revision retries a failed preferred source across views without changing its canonical source", async () => {
  const scope = "synthetic-account-library-a"
  useDeezerMetadataStore.setState({
    artists: {
      artist: {
        data: { image_url: "https://fixture/artist" } as any,
        cachedAt: Date.now(),
      },
    },
  })
  useArtworkPreferenceStore
    .getState()
    .setChoice(artworkPreferenceKey(scope, "artist", "Artist")!, "deezer")
  await render()
  const original = JSON.parse(
    document.querySelector("output")!.textContent!
  ).image
  await render({ failures: [original] })
  expect(JSON.parse(document.querySelector("output")!.textContent!).image).toBe(
    "plex-art"
  )
  await act(() =>
    useArtworkPreferenceStore
      .getState()
      .rememberRevision(scope, original, "synthetic-revision")
  )
  const revised = JSON.parse(
    document.querySelector("output")!.textContent!
  ).image
  expect(new URL(revised).searchParams.get("revision")).toBe(
    "synthetic-revision"
  )
  expect(new URL(revised).searchParams.get("src")).toBe(
    new URL(original).searchParams.get("src")
  )
  expect(new URL(revised).searchParams.get("scope")).toBe(scope)
})

test("artist and album background art resolve independently from saved poster choices and revisions", async () => {
  const scope = "synthetic-account-library-a"
  const image = (kind: string) =>
    `image://localhost/ext/img?src=${encodeURIComponent(`https://plex.test/library/metadata/${kind}`)}&scope=${scope}`
  useMetadataSourceStore.setState({ priority: ["apple", "deezer", "plex"] })
  useDeezerMetadataStore.setState({
    artists: {
      artist: {
        data: { image_url: "https://fixture/artist-cover" } as any,
        cachedAt: Date.now(),
      },
    },
    albums: {
      "artist::album": {
        data: {
          artist: "Artist",
          title: "Album",
          cover_url: "https://fixture/deezer-cover",
        } as any,
        cachedAt: Date.now(),
      },
    },
  })
  useItunesMetadataStore.setState({
    albums: {
      "artist::album": {
        data: {
          artist: "Artist",
          title: "Album",
          cover_url: "https://fixture/apple-cover",
        } as any,
        cachedAt: Date.now(),
      },
    },
  })
  useArtworkPreferenceStore
    .getState()
    .setChoice(artworkPreferenceKey(scope, "artist", "Artist")!, "deezer")
  useArtworkPreferenceStore
    .getState()
    .setChoice(
      artworkPreferenceKey(scope, "album", "Artist", "Album")!,
      "apple"
    )
  function Roles() {
    const artistPoster = useArtistArtwork(
      "Artist",
      image("artist/thumb"),
      "artist-id"
    )
    const artistBackground = useArtistBackgroundArtwork(
      "Artist",
      image("artist/art"),
      "artist-id"
    )
    const albumPoster = useAlbumArtwork(
      "Artist",
      "Album",
      image("album/thumb"),
      "album-id"
    )
    const albumBackground = useAlbumBackgroundArtwork(
      "Artist",
      "Album",
      image("album/art"),
      "album-id"
    )
    return (
      <output>
        {JSON.stringify({
          artistPoster,
          artistBackground,
          albumPoster,
          albumBackground,
        })}
      </output>
    )
  }
  await act(async () => root.render(<Roles />))
  const values = () =>
    JSON.parse(document.querySelector("output")!.textContent!)
  expect(values().artistPoster.source).toBe("deezer")
  expect(values().albumPoster.source).toBe("apple")
  expect(values().artistBackground.url).toBe(image("artist/art"))
  expect(values().albumBackground.url).toBe(image("album/art"))
  expect(values().artistBackground.preference).toBeNull()
  expect(values().albumBackground.preference).toBeNull()
  expect(requests).toEqual([])
  await act(() => {
    useArtworkPreferenceStore
      .getState()
      .setChoice(
        artworkPreferenceKey(
          scope,
          "artist",
          "Artist",
          undefined,
          "background"
        )!,
        "deezer"
      )
    useArtworkPreferenceStore
      .getState()
      .setChoice(
        artworkPreferenceKey(scope, "album", "Artist", "Album", "background")!,
        "deezer"
      )
  })
  const url = values().artistBackground.url
  expect(values().albumBackground.source).toBe("deezer")
  expect(values().albumPoster.source).toBe("apple")
  expect(new URL(url).searchParams.get("src")).toBe(
    "https://fixture/artist-cover"
  )
  expect(new URL(url).searchParams.get("scope")).toBe(scope)
  await act(() =>
    useArtworkPreferenceStore
      .getState()
      .rememberRevision(scope, url, "background-refresh", "background")
  )
  expect(
    new URL(values().artistBackground.url).searchParams.get("revision")
  ).toBe("background-refresh")
  expect(new URL(values().artistPoster.url).searchParams.has("revision")).toBe(
    false
  )
  expect(
    useArtworkPreferenceStore.getState().revisions[
      artworkRevisionKey(scope, url)!
    ]
  ).toBeUndefined()
  await act(() =>
    useArtworkPreferenceStore
      .getState()
      .setChoice(
        artworkPreferenceKey(
          scope,
          "artist",
          "Artist",
          undefined,
          "background"
        )!,
        null
      )
  )
  expect(values().artistBackground.url).toBe(image("artist/art"))
  expect(values().artistPoster.source).toBe("deezer")
})

test("verified Cover Art Archive album covers reject mismatched cached identities", async () => {
  useCoverArtArchiveMetadataStore.setState({
    _hasHydrated: true,
    albums: {
      "artist::album": {
        data: {
          artist: "Artist",
          title: "Album",
          mbid: "verified-id",
          cover_url: "https://synthetic.test/caa-cover",
        },
        cachedAt: Date.now(),
      },
    },
    getAlbum: async () => null,
  })
  useMetadataSourceStore.setState({
    priority: ["coverartarchive", "plex", "deezer", "apple"],
  })
  await render()
  expect(
    JSON.parse(document.querySelector("output")!.textContent!).album
  ).toContain("caa-cover")
  await act(() => {
    useCoverArtArchiveMetadataStore.setState({
      albums: {
        "artist::album": {
          data: {
            artist: "Other Artist",
            title: "Album",
            mbid: "verified-id",
            cover_url: "https://synthetic.test/wrong-cover",
          },
          cachedAt: Date.now(),
        },
      },
    })
  })
  await render()
  expect(JSON.parse(document.querySelector("output")!.textContent!).album).toBe(
    "plex-art"
  )
})

test("album Fanart images preserve per-role selections and expose cover reuse without claiming album fanart", async () => {
  const scope = "synthetic-account-library-a"
  await act(() => {
    useFanartServiceStore.setState({
      status: {
        revision: "one",
        baseUrl: "https://webservice.fanart.tv",
        configured: true,
        enabled: true,
        hasApiKey: true,
      },
    })
    useFanartMetadataStore.setState({
      albums: {
        "artist::album": {
          cachedAt: Date.now(),
          data: {
            artist: "Artist",
            title: "Album",
            mbid: "verified-mbid",
            revision: "one",
            posters: [
              { id: "a", url: "https://assets.fanart.tv/a.jpg" },
              { id: "b", url: "https://assets.fanart.tv/b.jpg" },
            ],
            backgrounds: [],
          },
        },
      },
    })
    useArtworkPreferenceStore
      .getState()
      .setCandidate(
        artworkPreferenceKey(scope, "album", "Artist", "Album")!,
        "fanart",
        "b"
      )
    useArtworkPreferenceStore
      .getState()
      .setCandidate(
        artworkPreferenceKey(scope, "album", "Artist", "Album", "background")!,
        "fanart",
        "a"
      )
  })
  function Albums() {
    const poster = useAlbumArtwork("Artist", "Album", "plex-poster", "album")
    const background = useAlbumBackgroundArtwork(
      "Artist",
      "Album",
      "plex-background",
      "album"
    )
    return <output>{JSON.stringify({ poster, background })}</output>
  }
  await act(() => root.render(<Albums />))
  const values = () =>
    JSON.parse(document.querySelector("output")!.textContent!)
  expect(new URL(values().poster.url).searchParams.get("src")).toBe(
    "https://assets.fanart.tv/b.jpg"
  )
  expect(new URL(values().background.url).searchParams.get("src")).toBe(
    "https://assets.fanart.tv/a.jpg"
  )
  expect(values().background.images.fanart[0].label).toContain(
    "reused as background"
  )
  await act(() =>
    useArtworkPreferenceStore
      .getState()
      .setCandidate(
        artworkPreferenceKey(scope, "album", "Artist", "Album")!,
        "fanart",
        "removed"
      )
  )
  expect(values().poster.url).toBe("plex-poster")
  expect(values().poster.refreshTargets.fanart).toBeNull()
  expect(new URL(values().background.url).searchParams.get("src")).toBe(
    "https://assets.fanart.tv/a.jpg"
  )
  await act(() =>
    useFanartServiceStore.setState({
      status: {
        revision: "two",
        baseUrl: "https://webservice.fanart.tv",
        configured: false,
        enabled: false,
        hasApiKey: false,
      },
    })
  )
  expect(values().background.url).toBe("plex-background")
})

test("Heya artist/album role URLs keep native service ownership separate from image refresh revision", async () => {
  const scope = "synthetic-account-library-a",
    revision = "22222222-2222-4222-8222-222222222222",
    posterId = "11111111-1111-4111-8111-111111111111",
    backgroundId = "33333333-3333-4333-8333-333333333333"
  const image = (id: string) => ({
    id,
    url: `heyametadata://image/${id}?serviceRevision=${revision}`,
    label: "Verified source",
  })
  await act(() => {
    useHeyaServiceStore.setState({
      status: {
        revision,
        baseUrl: "https://private.synthetic.test",
        enabled: true,
        configured: true,
        hasApiKey: true,
      },
    })
    const common = {
      id: "44444444-4444-4444-8444-444444444444",
      artist: "Artist",
      revision,
      posters: [image(posterId)],
      backgrounds: [image(backgroundId)],
    }
    useHeyaArtworkStore.setState({
      albums: {
        "artist::album": {
          revision,
          cachedAt: Date.now(),
          data: { ...common, title: "Album" },
        },
      },
      artists: {
        artist: {
          revision,
          cachedAt: Date.now(),
          data: { ...common, title: null },
        },
      },
    })
    for (const kind of ["artist", "album"] as const) {
      useArtworkPreferenceStore
        .getState()
        .setCandidate(
          artworkPreferenceKey(
            scope,
            kind,
            "Artist",
            kind === "album" ? "Album" : undefined
          )!,
          "heya",
          posterId
        )
      useArtworkPreferenceStore
        .getState()
        .setCandidate(
          artworkPreferenceKey(
            scope,
            kind,
            "Artist",
            kind === "album" ? "Album" : undefined,
            "background"
          )!,
          "heya",
          backgroundId
        )
    }
  })
  function Art() {
    const album = useAlbumArtwork("Artist", "Album", "plex-album", "album"),
      albumBackground = useAlbumBackgroundArtwork(
        "Artist",
        "Album",
        "plex-album-art",
        "album"
      ),
      artist = useArtistArtwork("Artist", "plex-artist", "artist"),
      artistBackground = useArtistBackgroundArtwork(
        "Artist",
        "plex-artist-art",
        "artist"
      )
    return (
      <output>
        {JSON.stringify({ album, albumBackground, artist, artistBackground })}
      </output>
    )
  }
  await act(() => root.render(<Art />))
  const values = () =>
    JSON.parse(document.querySelector("output")!.textContent!)
  for (const key of ["album", "artist"])
    expect(new URL(values()[key].url).searchParams.get("src")).toBe(
      image(posterId).url
    )
  for (const key of ["albumBackground", "artistBackground"])
    expect(new URL(values()[key].url).searchParams.get("src")).toBe(
      image(backgroundId).url
    )
  const url = values().albumBackground.url
  await act(() =>
    useArtworkPreferenceStore
      .getState()
      .rememberRevision(scope, url, "fresh-bytes", "background")
  )
  const refreshed = new URL(values().albumBackground.url)
  expect(refreshed.searchParams.get("revision")).toBe("fresh-bytes")
  expect(
    new URL(refreshed.searchParams.get("src")!).searchParams.get(
      "serviceRevision"
    )
  ).toBe(revision)
  expect(new URL(values().album.url).searchParams.has("revision")).toBe(false)
  expect(refreshed.toString()).not.toContain("private.synthetic.test")
})

test("late Fanart hydration replaces old-service positive through actual validator and native fetch", async () => {
  // Native invoke module mocks in other suites must not replace this real transport seam.
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/fanartHydration.tsx"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
})

test("offline explicit Heya UUID restores only its managed cache target without metadata requests", async () => {
  const scope = "synthetic-account-library-a",
    revision = "22222222-2222-4222-8222-222222222222",
    id = "11111111-1111-4111-8111-111111111111"
  useProviderStore.setState({
    provider: { cacheScope: scope, isOffline: true } as any,
  })
  useHeyaServiceStore.setState({
    status: {
      revision,
      baseUrl: "https://synthetic.test/",
      enabled: true,
      configured: true,
      hasApiKey: false,
    },
  })
  useHeyaArtworkStore.setState({
    artists: {},
    albums: {},
    getArtist: async () => {
      requests.push("unexpected-heya")
      return null
    },
    getAlbum: async () => {
      requests.push("unexpected-heya")
      return null
    },
  })
  const key = artworkPreferenceKey(scope, "artist", "Artist")!
  useArtworkPreferenceStore.getState().setCandidate(key, "heya", id)
  await render()
  const values = () =>
    JSON.parse(document.querySelector("output")!.textContent!)
  const target = values().image
  const ref = new URL(new URL(target).searchParams.get("src")!)
  expect(ref.hostname).toBe("image")
  expect(ref.pathname).toBe(`/${id}`)
  expect(ref.searchParams.get("serviceRevision")).toBe(revision)
  expect(new URL(target).searchParams.get("scope")).toBe(scope)
  expect(requests).toEqual([])
  await render({ failures: [target] })
  expect(values().image).toBe("plex-art")
  expect(requests).toEqual([])
  await act(() =>
    useArtworkPreferenceStore.getState().setCandidate(key, "heya", "invalid-id")
  )
  await render()
  expect(values().image).toBe("plex-art")
  expect(requests).toEqual([])
  await act(() =>
    useProviderStore.setState({
      provider: { cacheScope: "other", isOffline: true } as any,
    })
  )
  expect(values().image).toBe("plex-art")
})
