import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { settle, deferred } from "../helpers/radioAudioFakes"
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://synthetic.test",
})
globalThis.window = dom.window as any
globalThis.document = dom.window.document
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import("react-dom/client")
const { ArtworkSourcePicker } =
  await import("../../src/components/shared/ArtworkSourcePicker")
const { useArtistArtwork, useAlbumArtwork } =
  await import("../../src/hooks/useMediaImage")
const { useDeezerMetadataStore } =
  await import("../../src/metadata/deezer/store")
const { useItunesMetadataStore } =
  await import("../../src/metadata/apple/store")
const { useMetadataSourceStore } =
  await import("../../src/stores/metadataSourceStore")
const { useArtworkPreferenceStore, artworkPreferenceKey } =
  await import("../../src/stores/artworkPreferenceStore")
const { useProviderStore } = await import("../../src/stores/providerStore")
await settle()
useProviderStore.setState({
  provider: { cacheScope: "synthetic-account-a" } as any,
})
useMetadataSourceStore.setState({ priority: ["plex", "deezer", "apple"] })
useArtworkPreferenceStore.setState({ choices: {} })
let artistCalls = 0,
  albumCalls = 0,
  appleCalls = 0
useDeezerMetadataStore.setState({
  _hasHydrated: true,
  artists: {
    other: {
      data: { image_url: "https://synthetic.test/other" } as any,
      cachedAt: Date.now(),
    },
  },
  albums: {},
  getArtist: async (name) => {
    artistCalls++
    const data =
      artistCalls === 1
        ? null
        : ({ image_url: "https://synthetic.test/fresh" } as any)
    useDeezerMetadataStore.setState((s) => ({
      artists: {
        ...s.artists,
        [name.toLowerCase()]: { data, cachedAt: Date.now() },
      },
    }))
    return data
  },
  getAlbum: async () => {
    albumCalls++
    return null
  },
})
useItunesMetadataStore.setState({
  _hasHydrated: true,
  getAlbum: async () => {
    appleCalls++
    return null
  },
})
const bytes = deferred<void>()
let byteCalls = 0
let byteMode: "failure" | "success" | "delayed" = "failure"
const plexUrl =
  "image://localhost/artist/detail-id?src=https%3A%2F%2Fsynthetic.test%2Fplex&scope=synthetic-account-a"
function Harness() {
  const info = useArtistArtwork("Artist", plexUrl, "detail-id")
  return (
    <>
      <output>{info.url}</output>
      <ArtworkSourcePicker
        iconOnly
        label="Edit Artist artwork sources"
        kind="artist"
        artistName="Artist"
        plexThumb={plexUrl}
        entityId="detail-id"
        refreshImage={async () => {
          byteCalls++
          if (byteMode === "failure")
            throw new Error("private synthetic byte failure")
          if (byteMode === "delayed") await bytes.promise
          return {
            revision:
              byteMode === "delayed" ? "retired-revision" : "fresh-revision",
          }
        }}
      />
    </>
  )
}
const root = createRoot(document.getElementById("root")!)
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) =>
      b.getAttribute("aria-label") === label ||
      b.textContent!.trim() === label ||
      [...b.querySelectorAll("span")].some(
        (span) => span.textContent!.trim() === label
      )
  )!
const click = async (node: HTMLElement) => {
  await act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    await settle()
  })
}
try {
  await act(() => root.render(<Harness />))
  assert.equal(
    artistCalls,
    0,
    "closed picker must not perform extra source lookups"
  )
  const trigger = button("Edit Artist artwork sources")
  assert.ok(trigger, "icon chooser retains an accessible edit name")
  assert.equal(trigger.textContent, "")
  assert.equal(
    trigger.querySelector("svg")?.getAttribute("aria-hidden"),
    "true"
  )
  const outside = document.createElement("input")
  document.body.append(outside)
  outside.focus()
  assert.equal(document.activeElement, outside)
  await click(trigger)
  assert.equal(artistCalls, 1)
  assert.equal(
    albumCalls + appleCalls,
    0,
    "artist picker never queries album or Apple providers"
  )
  assert.equal(document.activeElement, button("Close"))
  assert.equal(document.querySelector("dialog")!.getAttribute("open"), "")
  assert.deepEqual(
    useArtworkPreferenceStore.getState().choices,
    {},
    "preview lookup must not select a source"
  )
  await click(button("Deezer"))
  const key = artworkPreferenceKey("synthetic-account-a", "artist", "Artist")!
  assert.equal(useArtworkPreferenceStore.getState().choices[key], "deezer")
  assert.ok(
    document
      .querySelector('[role="status"]')!
      .textContent!.includes("Plex fallback")
  )
  await click(button("Refresh choices"))
  assert.equal(artistCalls, 2)
  assert.ok(document.querySelector("output")!.textContent!.includes("fresh"))
  assert.ok(
    useDeezerMetadataStore.getState().artists.other,
    "single-item retry leaves unrelated metadata intact"
  )
  await click(button("Automatic"))
  assert.equal(useArtworkPreferenceStore.getState().choices[key], null)
  assert.equal(document.querySelector("output")!.textContent, plexUrl)
  await click(button("Close"))
  assert.equal(document.activeElement, trigger)
  assert.equal(
    document.getElementById("root")!.getAttribute("aria-hidden"),
    null
  )
  await click(trigger)
  await click(button("Plex"))
  const realTimeout = globalThis.setTimeout,
    realClear = globalThis.clearTimeout
  const imageTimers = new Map<number, () => void>()
  let nextImageTimer = 1
  globalThis.setTimeout = ((
    callback: () => void,
    delay?: number,
    ...args: any[]
  ) => {
    if (delay && delay >= 1000 && delay <= 2500) {
      const token = nextImageTimer++
      imageTimers.set(token, callback)
      return token
    }
    return realTimeout(callback, delay, ...args)
  }) as any
  globalThis.clearTimeout = ((timer: any) => {
    if (imageTimers.has(timer)) imageTimers.delete(timer)
    else realClear(timer)
  }) as any
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const preview = document.querySelector<HTMLImageElement>(
        'img[alt="Plex artwork preview"]'
      )!
      assert.ok(preview)
      await act(() => preview.dispatchEvent(new dom.window.Event("error")))
      if (attempt < 2)
        await act(() => {
          const [token, retry] = [...imageTimers][0]
          imageTimers.delete(token)
          retry()
        })
    }
  } finally {
    globalThis.setTimeout = realTimeout
    globalThis.clearTimeout = realClear
  }
  assert.ok(
    document
      .querySelector('[role="status"]')!
      .textContent!.includes("Deezer fallback")
  )
  assert.equal(
    button("Refresh image").disabled,
    false,
    "failed selected preview retains its validated refresh target"
  )
  await click(button("Refresh image"))
  assert.equal(byteCalls, 1)
  assert.equal(
    document.querySelector("output")!.textContent,
    plexUrl,
    "failure retains current pixels and revision"
  )
  assert.ok(document.body.textContent!.includes("Could not refresh this image"))
  assert.ok(
    document
      .querySelector('[role="status"]')!
      .textContent!.includes("Deezer fallback"),
    "failed refresh retains source fallback"
  )
  assert.ok(
    !document.body.textContent!.includes("private synthetic byte failure")
  )
  byteMode = "success"
  await click(button("Refresh image"))
  assert.ok(
    document
      .querySelector("output")!
      .textContent!.includes("revision=fresh-revision")
  )
  assert.equal(
    Object.values(useArtworkPreferenceStore.getState().revisions).length,
    1
  )
  assert.ok(
    document
      .querySelector<HTMLImageElement>('img[alt="Plex artwork preview"]')!
      .src.includes("revision=fresh-revision"),
    "successful refresh retries failed preview with fresh revision"
  )
  byteMode = "delayed"
  await click(button("Refresh image"))
  await act(() =>
    useProviderStore.setState({
      provider: { cacheScope: "synthetic-account-b" } as any,
    })
  )
  assert.equal(
    document.querySelector("dialog"),
    null,
    "account transition closes old entity controls"
  )
  await act(async () => {
    bytes.resolve()
    await settle()
  })
  assert.equal(document.querySelector("dialog"), null)
  assert.ok(
    !Object.values(useArtworkPreferenceStore.getState().revisions).includes(
      "retired-revision"
    )
  )
  assert.equal(
    useArtworkPreferenceStore.getState().choices[
      artworkPreferenceKey("synthetic-account-b", "artist", "Artist")!
    ],
    undefined
  )
  await act(() => {
    useDeezerMetadataStore.setState({
      albums: {},
      getAlbum: async (artist, album) => {
        albumCalls++
        const data = {
          artist,
          title: album,
          cover_url: "https://synthetic.test/deezer-album",
        } as any
        useDeezerMetadataStore.setState((s) => ({
          albums: {
            ...s.albums,
            [`${artist.toLowerCase()}::${album.toLowerCase()}`]: {
              data,
              cachedAt: Date.now(),
            },
          },
        }))
        return data
      },
    })
    useItunesMetadataStore.setState({
      albums: {},
      getAlbum: async (artist, album) => {
        appleCalls++
        const data = {
          artist,
          title: album,
          cover_url: "https://synthetic.test/apple-album",
        } as any
        useItunesMetadataStore.setState((s) => ({
          albums: {
            ...s.albums,
            [`${artist.toLowerCase()}::${album.toLowerCase()}`]: {
              data,
              cachedAt: Date.now(),
            },
          },
        }))
        return data
      },
    })
  })
  const albumPlexUrl = plexUrl.replace(
    "synthetic-account-a",
    "synthetic-account-b"
  )
  function AlbumHarness() {
    const info = useAlbumArtwork(
      "Artist",
      "Album",
      albumPlexUrl,
      "album-detail"
    )
    return (
      <>
        <output>{info.url}</output>
        <ArtworkSourcePicker
          kind="album"
          artistName="Artist"
          albumName="Album"
          plexThumb={albumPlexUrl}
          entityId="album-detail"
        />
      </>
    )
  }
  await act(() => root.render(<AlbumHarness />))
  assert.equal(albumCalls + appleCalls, 0)
  await click(button("Artwork sources"))
  assert.equal(albumCalls, 1)
  assert.equal(appleCalls, 1)
  await click(button("Apple Music"))
  assert.ok(
    document.querySelector("output")!.textContent!.includes("apple-album")
  )
  assert.equal(
    useArtworkPreferenceStore.getState().choices[
      artworkPreferenceKey("synthetic-account-b", "album", "Artist", "Album")!
    ],
    "apple"
  )
  await click(button("Refresh choices"))
  assert.equal(albumCalls, 1, "refresh does not invalidate the other provider")
  assert.equal(appleCalls, 2)
  await click(button("Automatic"))
  assert.equal(document.querySelector("output")!.textContent, albumPlexUrl)
} finally {
  await act(() => root.unmount())
  dom.window.close()
}
