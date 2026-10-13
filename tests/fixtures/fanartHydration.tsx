import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { settle } from "../helpers/radioAudioFakes"
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://synthetic.test",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { createRoot } = await import("react-dom/client")
const { useMetadataIdentityStore } =
  await import("../../src/stores/metadataIdentityStore")
useMetadataIdentityStore.setState({ choices: {}, versions: {}, hydrated: true })
const { useArtistArtwork } = await import("../../src/hooks/useMediaImage")
const { useFanartMetadataStore } =
  await import("../../src/metadata/fanart/store")
const { useFanartServiceStore } =
  await import("../../src/metadata/services/store")
const { useMusicBrainzMetadataStore } =
  await import("../../src/metadata/musicbrainz/store")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useMetadataSourceStore } =
  await import("../../src/stores/metadataSourceStore")
const { useArtworkPreferenceStore } =
  await import("../../src/stores/artworkPreferenceStore")
await settle()
const revision = "22222222-2222-4222-8222-222222222222",
  mbid = "11111111-1111-4111-8111-111111111111"
let calls = 0
useMusicBrainzMetadataStore.setState({
  getArtist: async () => ({ name: "Artist", mbid, wikidata_url: null }) as any,
})
// Keep the real @tauri/core invoke implementation and actual Fanart factory methods.
;(dom.window as any).__TAURI_INTERNALS__ = {
  invoke: async (command: string, args: any) => {
    assert.equal(command, "fanart_get_artist")
    assert.equal(args.revision, revision)
    assert.equal(args.artistMbid, mbid)
    calls++
    return {
      name: "Artist",
      mbid,
      revision,
      posters: [{ id: "current", url: "https://assets.fanart.tv/current.jpg" }],
      backgrounds: [],
      albums: [],
    }
  },
}
useProviderStore.setState({
  provider: { cacheScope: "synthetic-account" } as any,
})
useArtworkPreferenceStore.setState({
  choices: {},
  candidateChoices: {},
  revisions: {},
})
useFanartServiceStore.setState({
  status: {
    revision,
    baseUrl: "https://webservice.fanart.tv",
    configured: true,
    enabled: true,
    hasApiKey: true,
  },
})
useFanartMetadataStore.setState({ _hasHydrated: false, artists: {} })
useMetadataSourceStore.setState({ priority: ["fanart", "plex", "deezer"] })
function Artist() {
  const artwork = useArtistArtwork("Artist", "plex-artist", "artist")
  return <output>{JSON.stringify(artwork)}</output>
}
const root = createRoot(document.getElementById("root")!)
await act(() => root.render(<Artist />))
assert.equal(calls, 0)
await act(async () => {
  useFanartMetadataStore.setState({
    _hasHydrated: true,
    artists: {
      artist: {
        cachedAt: Date.now(),
        data: {
          name: "Artist",
          mbid,
          revision: "33333333-3333-4333-8333-333333333333",
          posters: [{ id: "stale", url: "https://assets.fanart.tv/stale.jpg" }],
          backgrounds: [],
          albums: [],
        },
      },
    },
  })
  await settle()
})
assert.equal(calls, 1)
const result = JSON.parse(document.querySelector("output")!.textContent!)
assert.equal(result.source, "fanart")
assert.equal(
  new URL(result.url).searchParams.get("src"),
  "https://assets.fanart.tv/current.jpg"
)
assert.equal(
  useFanartMetadataStore.getState().artists.artist.data?.revision,
  revision
)
await act(() => root.unmount())
dom.window.close()
