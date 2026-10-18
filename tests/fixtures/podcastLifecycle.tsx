import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import { Router } from "wouter"
import { deferred } from "../helpers/radioAudioFakes"
import type { PodcastEpisode } from "../../src/backends/podcast/api"
const scenario = process.argv[2]
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
globalThis.document = dom.window.document
globalThis.window = dom.window as any
globalThis.localStorage = dom.window.localStorage
;(globalThis as any).location = dom.window.location
;(globalThis as any).history = dom.window.history
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const requests: Array<{ command: string; args: any; pending: ReturnType<typeof deferred<any>> }> = []
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }))
mock.module("@tauri-apps/api/core", () => ({ invoke(command: string, args: any) {
  const pending = deferred<any>(); requests.push({ command, args, pending }); return pending.promise
} }))
mock.module("../../src/stores/sqliteStorage", () => ({
  safePersist: (creator: any) => creator,
  sqliteStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}))
const player = create<any>((set) => ({ currentTrack: null, isPlaying: false, playTrack: mock(async () => {}), pause: mock(() => set({ isPlaying: false })), resume: mock(() => set({ isPlaying: true })) }))
mock.module("../../src/stores/playerStore", () => ({ usePlayerStore: player }))
mock.module("../../src/components/ScrollRow", () => ({ ScrollRow: ({ title, children }: any) => <section><h2>{title}</h2>{children}</section> }))
mock.module("../../src/components/UltraBlur", () => ({ UltraBlur: () => null }))
// Lifecycle assertions do not mount a routed artwork shell.
mock.module("../../src/components/shared/MediaBackdrop", () => ({ AmbientHeroBackdrop: () => null }))
const reportError = console.error
console.error = (...args) => {
  if (typeof args[0] === "string" && /Failed to fetch (podcast feed|top podcasts):/.test(args[0])) return
  reportError(...args)
}
const { usePodcastStore } = await import("../../src/backends/podcast/store")
const { PodcastDetailPage } = await import("../../src/components/Pages/PodcastDetail")
const { PodcastsPage } = await import("../../src/components/Pages/Podcasts")
const { episodesToTracks, episodeProgressKey } = await import("../../src/backends/podcast/mappers")
const { podcastFeedPath } = await import("../../src/lib/podcastRoute")
const { buildExternalImageUrl } = await import("../../src/lib/imageUrl")
const state = () => usePodcastStore.getState()
const episode = (guid: string, audio = `https://media.test/${guid}.mp3`): PodcastEpisode => ({ guid, title: guid || "Untitled", description: "", pub_date: "2026-01-01", duration_secs: 300, audio_url: audio, audio_type: "audio/mpeg", audio_size: 0, episode_number: null, season_number: null, artwork_url: null })
const feed = (url: string, title: string) => ({ feed_url: url, title, author: "Author", description: "", artwork_url: "https://images.test/cover.jpg", link: "", language: "en", categories: [], episodes: [episode("one")] })
async function flush() { for (let turn = 0; turn < 12; turn++) await Promise.resolve() }
async function render(node: any) { await act(async () => { root.render(node); await flush() }) }
async function complete(request: typeof requests[number], value: any, error = false) {
  await act(async () => { if (error) request.pending.reject(value); else request.pending.resolve(value); await flush() })
}
async function click(button: Element) { await act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await flush() }) }
const button = (label: string) => [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === label)!
if (scenario === "detail-route") {
  await render(<PodcastDetailPage feedUrl="a" />)
  await render(<PodcastDetailPage feedUrl="b" />)
  await complete(requests[1], feed("b", "Current"))
  await complete(requests[0], feed("a", "Obsolete"))
  assert(document.body.textContent?.includes("Current"))
  assert(!document.body.textContent?.includes("Obsolete"))
  assert.equal(document.querySelector("img")?.getAttribute("src"), buildExternalImageUrl("https://images.test/cover.jpg"))
  await click(button("Subscribe"))
  assert(button("Subscribed"))
  await act(async () => { state().setEpisodeProgress("b", "one", 150) })
  assert(document.querySelector('[style="width: 50%;"]'))
  await act(async () => { state().markEpisodeCompleted("b", "one") })
  assert.equal(state().isEpisodeCompleted("b", "one"), true)
  const currentTrack = episodesToTracks(feed("b", "Current").episodes, "b", "Current", "Author", "")[0]
  await act(async () => { player.setState({ currentTrack, isPlaying: true }) })
  await click(document.querySelector('[aria-label="Pause one"]')!)
  assert.equal(player.getState().isPlaying, false)
  await click(document.querySelector('[aria-label="Play one"]')!)
  assert.equal(player.getState().isPlaying, true)
  assert.equal(player.getState().playTrack.mock.calls.length, 0)
} else if (scenario === "detail-error") {
  await render(<PodcastDetailPage feedUrl="a" />)
  await complete(requests[0], new Error("offline"), true)
  assert(document.body.textContent?.includes("Failed to load podcast feed."))
  await click(button("Try again"))
  assert.equal(requests.length, 2)
  await complete(requests[1], feed("a", "Recovered"))
  assert(document.body.textContent?.includes("Recovered"))
} else if (scenario === "search-race") {
  const first = state().searchPodcasts("old"), second = state().searchPodcasts("new")
  requests[1].pending.resolve([{ id: 2, name: "new" }]); await second
  requests[0].pending.resolve([{ id: 1, name: "old" }]); await first
  assert.equal(state().searchResults[0].name, "new")
  const late = state().searchPodcasts("late")
  state().clearSearch()
  requests[2].pending.reject(new Error("stale failure")); await late
  assert.equal(state().lastError, null)
  assert.equal(state().isSearching, false)
  assert.deepEqual(state().searchResults, [])
  const blanked = state().searchPodcasts("blanked")
  await state().searchPodcasts(" ")
  requests[3].pending.resolve([{ id: 3 }]); await blanked
  assert.deepEqual(state().searchResults, [])
} else if (scenario === "category-retirement") {
  await render(<Router><PodcastsPage /></Router>)
  await complete(requests.find(request => request.command === "podcast_get_categories")!, [{ id: 1, name: "Science" }])
  await complete(requests.find(request => request.command === "podcast_get_top")!, [])
  await click(button("Science"))
  const category = requests.at(-1)!
  await click(button("Science")) // Deselect while the request is pending.
  await complete(category, new Error("obsolete failure"), true)
  await click(button("Science"))
  const retry = requests.at(-1)!
  await complete(retry, [{ itunes_id: 1, name: "Current science", artist_name: "Author", artwork_url: "", feed_url: "https://feed.test/science" }])
  assert(document.body.textContent?.includes("Current science"))
  assert(!document.body.textContent?.includes("Failed to load Science"))
} else if (scenario === "lookup-error") {
  await render(<Router><PodcastsPage /></Router>)
  await complete(requests.find(request => request.command === "podcast_get_categories")!, [])
  await complete(requests.find(request => request.command === "podcast_get_top")!, [{ itunes_id: 1, name: "Lookup", artist_name: "Author", artwork_url: "", feed_url: "" }])
  assert.equal(document.querySelector('input[aria-label="Search podcasts"]')?.tagName, "INPUT")
  const card = document.querySelector<HTMLButtonElement>('button[aria-label="Open podcast Lookup"]')!
  assert.equal(card.type, "button")
  card.focus()
  assert.equal(document.activeElement, card)
  // Native buttons convert Enter/Space activation to click without pointer handlers.
  await act(async () => { card.click(); await flush() })
  await complete(requests.at(-1)!, new Error("offline"), true)
  assert(document.body.textContent?.includes("Could not open podcast"))
  await act(async () => usePodcastStore.setState({ lastError: "Fixture podcast error" }))
  const dismiss = document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss podcast error"]')!
  assert(dismiss)
  dismiss.focus()
  assert.equal(document.activeElement, dismiss)
  await act(async () => { dismiss.click(); await flush() })
  assert.equal(state().lastError, null)
  assert(!document.body.textContent?.includes("Fixture podcast error"))
 } else if (scenario === "search-unmount") {
  await render(<Router><PodcastsPage /></Router>)
  await complete(requests.find(request => request.command === "podcast_get_categories")!, [])
  await complete(requests.find(request => request.command === "podcast_get_top")!, [])
  const input = document.querySelector("input")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "queued")
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    await flush()
  })
  assert(document.body.textContent?.includes("Searching..."))
  await act(async () => root.unmount())
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.equal(requests.length, 2, "unmounted debounce must not invoke the API")
 } else if (scenario === "route-links") {
  const unicodeFeed = "https://feeds.test/播客.xml?token=a/b+c="
  await render(<Router><PodcastsPage /></Router>)
  await complete(requests.find(request => request.command === "podcast_get_categories")!, [])
  await complete(requests.find(request => request.command === "podcast_get_top")!, [{ itunes_id: 1, name: "Unicode", artist_name: "Author", artwork_url: "", feed_url: unicodeFeed }])
  await click(document.querySelector('button[aria-label="Open podcast Unicode"]')!)
  assert.equal(dom.window.location.pathname, podcastFeedPath(unicodeFeed))
  await render(<PodcastDetailPage feedUrl={unicodeFeed} />)
  const request = requests.at(-1)!
  assert.equal(request.args.feedUrl, unicodeFeed)
  await complete(request, feed(unicodeFeed, "Current"))
  await click(document.querySelector('[aria-label="Play one"]')!)
  assert.equal(player.getState().playTrack.mock.calls.at(-1)[3], podcastFeedPath(unicodeFeed))
} else if (scenario === "identity") {
  const map = (episodes: PodcastEpisode[], url: string) => episodesToTracks(episodes, url, "Podcast", "Author", "")
  assert.notEqual(map([episode("Aa")], "a")[0].id, map([episode("BB")], "a")[0].id)
  assert.notEqual(map([episode("same")], "a")[0].id, map([episode("same")], "b")[0].id)
  const missing = [episode("", "https://media.test/one"), episode("", "https://media.test/two")]
  assert.notEqual(map(missing, "a")[0].id, map(missing, "a")[1].id)
  assert.notEqual(episodeProgressKey(missing[0]), episodeProgressKey(missing[1]))
  assert.equal(episodeProgressKey(episode("existing-guid")), "existing-guid")
  assert.equal((map(missing, "a")[0]._providerData as any).feedUrl, "a")
  const artworkTrack = episodesToTracks([episode("cover")], "a", "Podcast", "Author", "https://images.test/cover.jpg")[0]
  assert.equal(artworkTrack.thumbUrl, buildExternalImageUrl("https://images.test/cover.jpg"))
}
await act(async () => root.unmount())
