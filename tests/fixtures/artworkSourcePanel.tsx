import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { deferred, settle } from "../helpers/radioAudioFakes"
const dom = new JSDOM(
  "<button id='before'>Before panel</button><div id='root'></div><button id='after'>After panel</button>",
  { url: "https://synthetic.test" }
)
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { createRoot } = await import("react-dom/client")
const { ArtworkSourcePanel } =
  await import("../../src/components/shared/ArtworkSourcePicker")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useArtworkPreferenceStore, artworkPreferenceKey } =
  await import("../../src/stores/artworkPreferenceStore")
const { useMetadataSourceStore } =
  await import("../../src/stores/metadataSourceStore")
const { useDeezerMetadataStore } =
  await import("../../src/metadata/deezer/store")
const { useItunesMetadataStore } =
  await import("../../src/metadata/apple/store")
const { useCoverArtArchiveMetadataStore } =
  await import("../../src/metadata/coverartarchive/store")
useCoverArtArchiveMetadataStore.setState({
  _hasHydrated: true,
  albums: {},
  getAlbum: async () => null,
})
await settle()
const provider: any = { cacheScope: "account-a" }
useProviderStore.setState({ provider })
useArtworkPreferenceStore.setState({ choices: {}, revisions: {} })
useMetadataSourceStore.setState({ priority: ["plex", "deezer", "apple"] })
const cover = {
  artist: "Artist",
  title: "Album",
  cover_url: "https://synthetic.test/album-cover",
} as any
useDeezerMetadataStore.setState({
  _hasHydrated: true,
  artists: {
    artist: {
      data: { image_url: "https://synthetic.test/artist-cover" } as any,
      cachedAt: Date.now(),
    },
  },
  albums: { "artist::album": { data: cover, cachedAt: Date.now() } },
  getArtist: async () => null,
  getAlbum: async () => cover,
})
useItunesMetadataStore.setState({
  _hasHydrated: true,
  albums: {},
  getAlbum: async () => null,
})
const bytes = deferred<{ revision: string }>(),
  newBytes = deferred<{ revision: string }>(),
  sessionBytes = deferred<{ revision: string }>(),
  roleBytes = deferred<{ revision: string }>()
const heyaBytes = deferred<{ revision: string }>()
const fanartBytes = deferred<{ revision: string }>()
let lastRefresh: { source: string; url: string } | null = null
let calls = 0
const root = createRoot(document.getElementById("root")!)
function Panel({
  kind = "artist",
  name = "Artist",
  role = "poster",
}: {
  kind?: "artist" | "album"
  name?: string
  role?: "poster" | "background"
}) {
  return (
    <section role="dialog" aria-label="Parent metadata editor">
      <ArtworkSourcePanel
        kind={kind}
        artistName={name}
        albumName={kind === "album" ? "Album" : undefined}
        entityId={kind}
        role={role}
        plexArt={`image://localhost/ext/img?src=${encodeURIComponent(`https://plex.test/${kind}/art`)}&scope=account-a`}
        plexThumb={null}
        refreshImage={async (source, url) => {
          lastRefresh = { source, url }
          calls++
          if (calls >= 6) return heyaBytes.promise
          if (calls >= 5) return fanartBytes.promise
          return calls === 1
            ? bytes.promise
            : calls === 2
              ? newBytes.promise
              : calls === 3
                ? sessionBytes.promise
                : roleBytes.promise
        }}
      />
    </section>
  )
}
async function render(
  kind: "artist" | "album" = "artist",
  name = "Artist",
  role: "poster" | "background" = "poster"
) {
  await act(async () => {
    root.render(<Panel kind={kind} name={name} role={role} />)
    await settle()
  })
}
function button(label: string) {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("#root button"),
  ].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.textContent!.trim() === label
  )
  assert.ok(found, label)
  return found!
}
async function click(label: string) {
  await act(async () => {
    button(label).click()
    await settle()
  })
}
document.body.style.overflow = "auto"
document.getElementById("after")!.focus()
await render()
assert.equal(
  document.querySelector("dialog"),
  null,
  "inline choices cannot create a nested native dialog"
)
assert.equal(document.body.style.overflow, "auto")
assert.equal(document.getElementById("after")!.getAttribute("inert"), null)
assert.equal(document.activeElement, document.getElementById("after"))
assert.ok(
  document
    .querySelector('img[alt="Deezer artwork preview"]')!
    .getAttribute("src")!
    .startsWith("image://")
)
assert.ok(
  document
    .querySelector('img[alt="Deezer artwork preview"]')!
    .getAttribute("src")!
    .includes("account-a")
)
const source = button("Use Deezer artwork")
assert.equal(source.type, "button")
assert.equal(source.tabIndex, 0)
source.focus()
await act(async () => {
  source.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  )
  source.click()
  await settle()
})
assert.equal(
  useArtworkPreferenceStore.getState().choices[
    artworkPreferenceKey("account-a", "artist", "Artist")!
  ],
  "deezer"
)
document.getElementById("after")!.focus()
assert.equal(
  document.activeElement,
  document.getElementById("after"),
  "inline panel cannot steal surrounding editor focus"
)
const refresh = button("Refresh image")
await act(async () => {
  refresh.click()
  refresh.click()
})
assert.equal(calls, 1, "same-frame refresh must admit only one request")
await act(async () => {
  useProviderStore.setState({ provider: { cacheScope: "account-a" } as any })
  await settle()
})
await act(async () => {
  bytes.resolve({ revision: "retired-account-revision" })
  await settle()
})
assert.equal(
  Object.values(useArtworkPreferenceStore.getState().revisions).includes(
    "retired-account-revision"
  ),
  false
)
assert.equal(document.body.textContent!.includes("Image refreshed."), false)
await render("album")
assert.ok(
  document
    .querySelector('img[alt="Deezer artwork preview"]')!
    .getAttribute("src")!
    .includes("album-cover"),
  "album panel uses validated cached external artwork"
)
await click("Use Deezer artwork")
assert.equal(
  useArtworkPreferenceStore.getState().choices[
    artworkPreferenceKey("account-a", "album", "Artist", "Album")!
  ],
  "deezer"
)
await act(async () => button("Refresh image").click())
assert.equal(calls, 2)
await render("album", "Different artist")
await act(async () => {
  newBytes.resolve({ revision: "retired-item-revision" })
  await settle()
})
assert.equal(
  Object.values(useArtworkPreferenceStore.getState().revisions).includes(
    "retired-item-revision"
  ),
  false
)
assert.equal(document.body.textContent!.includes("Image refreshed."), false)
assert.equal(
  useArtworkPreferenceStore.getState().choices[
    artworkPreferenceKey("account-a", "album", "Different artist", "Album")!
  ],
  undefined
)
await render("artist")
await act(async () => button("Refresh image").click())
assert.equal(calls, 3)
await act(async () => {
  const sameProvider = useProviderStore.getState().provider as any
  sameProvider.playbackSession = {}
  useProviderStore.setState({ provider: sameProvider })
  await settle()
})
await act(async () => {
  sessionBytes.resolve({ revision: "retired-session-revision" })
  await settle()
})
assert.equal(
  Object.values(useArtworkPreferenceStore.getState().revisions).includes(
    "retired-session-revision"
  ),
  false
)
assert.equal(document.body.textContent!.includes("Image refreshed."), false)
await act(() =>
  useArtworkPreferenceStore
    .getState()
    .setChoice(artworkPreferenceKey("account-a", "artist", "Artist")!, "plex")
)
await render("artist", "Artist", "background")
assert.equal(
  new URL(
    document
      .querySelector('img[alt="Plex artwork preview"]')!
      .getAttribute("src")!
  ).searchParams.get("src"),
  "https://plex.test/artist/art"
)
await click("Use Deezer artist image as background")
assert.equal(
  useArtworkPreferenceStore.getState().choices[
    artworkPreferenceKey(
      "account-a",
      "artist",
      "Artist",
      undefined,
      "background"
    )!
  ],
  "deezer"
)
assert.equal(
  useArtworkPreferenceStore.getState().choices[
    artworkPreferenceKey("account-a", "artist", "Artist")!
  ],
  "plex"
)
assert.ok(document.body.textContent!.includes("reused as a background"))
await act(async () => button("Refresh image").click())
assert.equal(calls, 4)
await render("artist", "Artist", "poster")
await act(async () => {
  roleBytes.resolve({ revision: "retired-role-revision" })
  await settle()
})
assert.equal(
  Object.values(useArtworkPreferenceStore.getState().revisions).includes(
    "retired-role-revision"
  ),
  false
)
await render("album", "Artist", "background")
assert.equal(
  new URL(
    document
      .querySelector('img[alt="Plex artwork preview"]')!
      .getAttribute("src")!
  ).searchParams.get("src"),
  "https://plex.test/album/art"
)
assert.equal(
  useArtworkPreferenceStore.getState().choices[
    artworkPreferenceKey("account-a", "album", "Artist", "Album", "background")!
  ],
  undefined
)
assert.equal(
  useArtworkPreferenceStore.getState().choices[
    artworkPreferenceKey("account-a", "album", "Artist", "Album")!
  ],
  "deezer"
)
await act(async () =>
  useCoverArtArchiveMetadataStore.setState({
    albums: {
      "artist::album": {
        data: {
          artist: "Artist",
          title: "Album",
          mbid: "verified-record",
          cover_url: "https://synthetic.test/caa",
        },
        cachedAt: Date.now(),
      },
    },
  })
)
await click("Use Cover Art Archive album cover as background")
assert.equal(
  useArtworkPreferenceStore.getState().choices[
    artworkPreferenceKey("account-a", "album", "Artist", "Album", "background")!
  ],
  "coverartarchive"
)
assert.ok(
  document
    .querySelector('img[alt="Cover Art Archive artwork preview"]')!
    .getAttribute("src")!
    .includes("synthetic.test%2Fcaa")
)
assert.equal(
  useArtworkPreferenceStore.getState().choices[
    artworkPreferenceKey("account-a", "album", "Artist", "Album")!
  ],
  "deezer"
)
assert.equal(
  document.querySelector('button[aria-label^="Use Fanart.tv"]'),
  null
)
assert.equal(
  document.querySelector('button[aria-label^="Use Heya Metadata"]'),
  null
)
const { useFanartMetadataStore } =
  await import("../../src/metadata/fanart/store")
const { useFanartServiceStore } =
  await import("../../src/metadata/services/store")
await act(async () => {
  useFanartServiceStore.setState({
    status: {
      revision: "config-one",
      baseUrl: "https://webservice.fanart.tv",
      configured: true,
      enabled: true,
      hasApiKey: true,
    },
  })
  useFanartMetadataStore.setState({
    _hasHydrated: true,
    artists: {
      artist: {
        cachedAt: Date.now(),
        data: {
          name: "Artist",
          mbid: "verified-mbid",
          revision: "config-one",
          posters: [
            {
              id: "poster-one",
              url: "https://assets.fanart.tv/poster-one.jpg",
              label: "Poster one",
            },
          ],
          backgrounds: [
            {
              id: "wide-one",
              url: "https://assets.fanart.tv/wide-one.jpg",
              label: "Wide one",
            },
            {
              id: "wide-two",
              url: "https://assets.fanart.tv/wide-two.jpg",
              label: "Wide two",
            },
          ],
          albums: [],
        },
      },
    },
    getArtist: async () => null,
    getAlbum: async () => null,
  })
})
await render("artist", "Artist", "background")
assert.equal(
  document.querySelectorAll('img[alt="Fanart.tv artwork preview"]').length,
  2
)
await click("Use Fanart.tv background Wide two")
assert.equal(
  useArtworkPreferenceStore.getState().candidateChoices[
    artworkPreferenceKey(
      "account-a",
      "artist",
      "Artist",
      undefined,
      "background"
    )!
  ]?.id,
  "wide-two"
)
assert.equal(
  useArtworkPreferenceStore.getState().choices[
    artworkPreferenceKey("account-a", "artist", "Artist")!
  ],
  "plex"
)
await act(async () => button("Refresh image").click())
assert.equal(calls, 5)
assert.equal(lastRefresh!.source, "fanart")
assert.equal(
  new URL(lastRefresh!.url).searchParams.get("src"),
  "https://assets.fanart.tv/wide-two.jpg"
)
await act(async () =>
  useFanartServiceStore.setState({
    status: {
      revision: "config-two",
      baseUrl: "https://webservice.fanart.tv",
      configured: false,
      enabled: false,
      hasApiKey: false,
    },
  })
)
assert.equal(
  document.querySelectorAll('img[alt="Fanart.tv artwork preview"]').length,
  0
)
assert.equal(
  document.querySelector('button[aria-label^="Use Fanart.tv"]'),
  null
)
assert.equal(
  useArtworkPreferenceStore.getState().candidateChoices[
    artworkPreferenceKey(
      "account-a",
      "artist",
      "Artist",
      undefined,
      "background"
    )!
  ]?.id,
  "wide-two"
)
assert.ok(
  document.querySelector('[role="status"]')!.textContent!.includes("fallback")
)
await act(async () => {
  fanartBytes.resolve({ revision: "retired-fanart-refresh" })
  await settle()
})
assert.equal(
  Object.values(useArtworkPreferenceStore.getState().revisions).includes(
    "retired-fanart-refresh"
  ),
  false
)
const { useHeyaArtworkStore } =
  await import("../../src/metadata/heya/artworkStore")
const { useHeyaServiceStore } =
  await import("../../src/metadata/services/store")
const heyaRevision = "22222222-2222-4222-8222-222222222222",
  heyaOne = "11111111-1111-4111-8111-111111111111",
  heyaTwo = "33333333-3333-4333-8333-333333333333"
const heyaImage = (id: string, label: string) => ({
  id,
  url: `heyametadata://image/${id}?serviceRevision=${heyaRevision}`,
  label,
})
await act(async () => {
  useHeyaServiceStore.setState({
    status: {
      revision: heyaRevision,
      baseUrl: "https://private.synthetic.test",
      enabled: true,
      configured: true,
      hasApiKey: true,
    },
  })
  useHeyaArtworkStore.setState({
    artists: {
      artist: {
        revision: heyaRevision,
        cachedAt: Date.now(),
        data: {
          id: "44444444-4444-4444-8444-444444444444",
          artist: "Artist",
          title: null,
          revision: heyaRevision,
          posters: [heyaImage(heyaOne, "Source · profile")],
          backgrounds: [
            heyaImage(heyaOne, "Source · backdrop one"),
            heyaImage(heyaTwo, "Source · backdrop two"),
          ],
        },
      },
    },
    getArtist: async () => null,
    getAlbum: async () => null,
  })
})
await render("artist", "Artist", "background")
assert.equal(
  document.querySelectorAll('img[alt="Heya Metadata artwork preview"]').length,
  2
)
await click("Use Heya Metadata background Source · backdrop two")
assert.equal(
  useArtworkPreferenceStore.getState().candidateChoices[
    artworkPreferenceKey(
      "account-a",
      "artist",
      "Artist",
      undefined,
      "background"
    )!
  ]?.id,
  heyaTwo
)
assert.equal(
  useArtworkPreferenceStore.getState().choices[
    artworkPreferenceKey("account-a", "artist", "Artist")!
  ],
  "plex"
)
await act(async () => button("Refresh image").click())
assert.equal(calls, 6)
assert.equal(lastRefresh!.source, "heya")
const refreshed = new URL(lastRefresh!.url)
assert.equal(refreshed.searchParams.get("scope"), "account-a")
assert.equal(
  refreshed.searchParams.get("src"),
  `heyametadata://image/${heyaTwo}?serviceRevision=${heyaRevision}`
)
assert.ok(!lastRefresh!.url.includes("private.synthetic.test"))
await act(async () =>
  useHeyaServiceStore.setState({
    status: {
      revision: "55555555-5555-4555-8555-555555555555",
      baseUrl: "https://private.synthetic.test",
      enabled: false,
      configured: false,
      hasApiKey: false,
    },
  })
)
await act(async () => {
  heyaBytes.resolve({ revision: "retired-heya-refresh" })
  await settle()
})
assert.equal(
  Object.values(useArtworkPreferenceStore.getState().revisions).includes(
    "retired-heya-refresh"
  ),
  false
)
assert.equal(
  document.querySelectorAll('img[alt="Heya Metadata artwork preview"]').length,
  0
)
assert.equal(
  document.querySelector('button[aria-label^="Use Heya Metadata"]'),
  null
)
assert.equal(
  useArtworkPreferenceStore.getState().candidateChoices[
    artworkPreferenceKey(
      "account-a",
      "artist",
      "Artist",
      undefined,
      "background"
    )!
  ]?.id,
  heyaTwo
)
// Each availability condition is required; disabled or unconfigured services stay hidden.
await act(async () => {
  useFanartServiceStore.setState({
    status: {
      revision: "config-disabled",
      baseUrl: "https://webservice.fanart.tv",
      enabled: false,
      configured: true,
      hasApiKey: true,
    },
  })
  useHeyaServiceStore.setState({
    status: {
      revision: "77777777-7777-4777-8777-777777777777",
      baseUrl: "https://private.synthetic.test",
      enabled: true,
      configured: false,
      hasApiKey: false,
    },
  })
})
assert.equal(
  document.querySelector('button[aria-label^="Use Fanart.tv"]'),
  null
)
assert.equal(
  document.querySelector('button[aria-label^="Use Heya Metadata"]'),
  null
)
// Configured services remain offered even when this item has no matching images.
await act(async () => {
  useFanartServiceStore.setState({
    status: {
      revision: "config-three",
      baseUrl: "https://webservice.fanart.tv",
      enabled: true,
      configured: true,
      hasApiKey: true,
    },
  })
  useHeyaServiceStore.setState({
    status: {
      revision: "66666666-6666-4666-8666-666666666666",
      baseUrl: "https://private.synthetic.test",
      enabled: true,
      configured: true,
      hasApiKey: true,
    },
  })
})
await render("artist", "Artist", "poster")
assert.ok(document.querySelector('button[aria-label="Use Fanart.tv artwork"]'))
assert.ok(
  document.querySelector('button[aria-label="Use Heya Metadata artwork"]')
)
assert.equal(
  document.querySelectorAll('img[alt="Fanart.tv artwork preview"]').length,
  0
)
assert.equal(
  document.querySelectorAll('img[alt="Heya Metadata artwork preview"]').length,
  0
)
assert.equal(
  useArtworkPreferenceStore.getState().choices[
    artworkPreferenceKey("account-a", "artist", "Artist")!
  ],
  "plex"
)
await render("artist", "Artist", "background")
assert.ok(
  document.querySelector('button[aria-label="Use Fanart.tv background"]')
)
assert.ok(
  document.querySelector('button[aria-label="Use Heya Metadata background"]')
)
assert.equal(
  useArtworkPreferenceStore.getState().candidateChoices[
    artworkPreferenceKey(
      "account-a",
      "artist",
      "Artist",
      undefined,
      "background"
    )!
  ]?.id,
  heyaTwo
)
await act(async () => root.unmount())
assert.equal(document.body.style.overflow, "auto")
dom.window.close()
