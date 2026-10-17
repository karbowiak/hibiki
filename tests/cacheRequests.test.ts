import { expect, test } from "bun:test"
import { CacheRequests } from "../src/lib/cacheRequests"
import { deferred } from "./helpers/radioAudioFakes"

test("clear retires publication and an old completion cannot remove its replacement", async () => {
  const cache = new CacheRequests(),
    old = deferred<string>(),
    fresh = deferred<string>()
  const values: string[] = []
  const first = cache.load(
    "item",
    () => old.promise,
    (value) => values.push(value)
  )
  cache.clear()
  const second = cache.load(
    "item",
    () => fresh.promise,
    (value) => values.push(value)
  )
  old.resolve("obsolete")
  expect(await first).toBeNull()
  expect(
    cache.load(
      "item",
      () => {
        throw Error("duplicate")
      },
      () => {}
    )
  ).toBe(second)
  fresh.resolve("current")
  expect(await second).toBe("current")
  expect(values).toEqual(["current"])
})
