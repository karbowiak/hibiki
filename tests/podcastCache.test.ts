import { expect, test } from "bun:test"
import { boundPodcastCaches } from "../src/backends/podcast/cache"
import { PreferencePersistence } from "../src/stores/preferencePersistence"

test("podcast cache retention and byte limits leave primary data independent", () => {
  const feedCache = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [String(i), { cachedAt: Date.now() - i, data: { episodes: [{ description: "x".repeat(600_000) }] } }])) as any
  const bounded = boundPodcastCaches({ feedCache })
  expect(Object.keys(bounded.feedCache).length).toBeLessThanOrEqual(32)
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(16 * 1024 * 1024)
  expect(bounded.feedCache["0"]).toBeDefined()
})

test("a progress write retires legacy feed blobs while preserving primary and future fields", async () => {
  let raw = JSON.stringify({ version: 0, state: { subscriptions: [{ feedUrl: "feed" }], listenProgress: {}, completedEpisodes: {}, feedCache: { huge: "x".repeat(1_000_000) }, topChartCache: {}, futurePreference: true } })
  const service = new PreferencePersistence({ get: () => raw, remove: () => {}, update: (_key, fn) => { raw = fn(raw) } })
  const session = service.register("podcast", { discardFields: ["feedCache", "topChartCache"] })
  const saved = (await session.read())!.state
  session.baseline(saved)
  session.hydrated()
  await session.stage({ ...saved, listenProgress: { feed: { episode: 5 } } })
  await service.flush()
  const result = JSON.parse(raw).state
  expect(result.subscriptions).toEqual([{ feedUrl: "feed" }])
  expect(result.listenProgress.feed.episode).toBe(5)
  expect(result.futurePreference).toBe(true)
  expect(result.feedCache).toBeUndefined()
  expect(raw.length).toBeLessThan(500)
})
