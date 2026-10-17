import { expect, test } from "bun:test"
import { emptyFavorites, setFavorite } from "../src/favorites/model"
import { effectiveTrackRating, favoriteRatingIndex, favoriteRatingIntent, trackRatingHint } from "../src/favorites/ratings"
import { validFavorite } from "../src/favorites/validation"
import { resolve } from "node:path"
const row = { key: "remote:1", localTrackId: "1", title: "Song", artist: "Artist", likedAt: 1400000000000 }

test("imported and legacy likes derive local three stars without overwriting original or higher Plex ratings", () => {
  const state = setFavorite(emptyFavorites(), row, true, false)
  const saved = JSON.stringify(state)
  const item = favoriteRatingIndex(state).get("1")!
  expect(effectiveTrackRating(null, item)).toBe(6)
  expect(effectiveTrackRating(10, item)).toBe(10)
  expect(effectiveTrackRating(2, item)).toBe(6)
  expect(state.entries[row.key].rating).toBeUndefined()
  expect(JSON.stringify(state)).toBe(saved)
  expect(trackRatingHint(null, item)).toContain("Plex's rating is unchanged")
})
test("manual lower/clear choices and remote unlikes have one coherent star display", () => {
  let state = setFavorite(emptyFavorites(), row, true)
  const intent = favoriteRatingIntent(10, "1")
  state.entries[row.key].rating = intent
  expect(effectiveTrackRating(null, favoriteRatingIndex(state).get("1"))).toBe(10)
  state = setFavorite(state, row, false, true)
  expect(effectiveTrackRating(10, favoriteRatingIndex(state).get("1"))).toBe(null)
  state.entries[row.key].rating = favoriteRatingIntent(2, "1")
  expect(effectiveTrackRating(10, favoriteRatingIndex(state).get("1"))).toBe(2)
  state.entries[row.key].rating = favoriteRatingIntent(null, "1")
  expect(effectiveTrackRating(10, favoriteRatingIndex(state).get("1"))).toBe(null)
  expect(validFavorite(state.entries[row.key])).toBe(true)
})
test("unchanged sync observations reuse rating projections rather than refreshing every visible star control", () => {
  const state = setFavorite(emptyFavorites(), row, true, false)
  const first = favoriteRatingIndex(state)
  const second = favoriteRatingIndex(structuredClone(state), first)
  expect(first.get("1")).toBe(second.get("1"))
})
for (const scenario of ["lower", "clear", "race"])
  test(`unified rating persistence and provider writes: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "tests/fixtures/unifiedRatings.ts", scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    const [status, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ status, output: out + err }).toEqual({ status: 0, output: "" })
  })
