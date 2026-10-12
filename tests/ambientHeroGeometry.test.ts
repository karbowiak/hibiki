import { expect, test } from "bun:test"
import { createAmbientArtworkController } from "../src/stores/ambientArtworkStore"
import type { MusicProvider } from "../src/providers/types"
test("ambient hero geometry cannot claim an image and follows route, lease and account ownership", () => {
  let provider = { cacheScope: "one" } as MusicProvider
  const controller = createAmbientArtworkController(() => ({
    provider,
    scope: provider.cacheScope ?? undefined,
  }))
  const older = controller.acquireHero("old", provider, "one"),
    latest = controller.acquireHero("new", provider, "one")
  const align = {
    heroW: 900,
    heroH: 460,
    heroTop: 84,
    heroLeft: 240,
    scrollTop: 0,
  }
  older.update({ route: "/playlist/one", align })
  latest.update({ route: "/playlist/one", align: { ...align, scrollTop: 120 } })
  expect(controller.getWinner("/playlist/one", provider, "one")).toBeNull()
  expect(
    controller.getHeroWinner("/playlist/one", provider, "one")?.scrollTop
  ).toBe(120)
  older.update({ route: "/playlist/one", align: { ...align, scrollTop: 30 } })
  expect(
    controller.getHeroWinner("/playlist/one", provider, "one")?.scrollTop
  ).toBe(120)
  expect(controller.getHeroWinner("/search", provider, "one")).toBeUndefined()
  latest.release()
  expect(
    controller.getHeroWinner("/playlist/one", provider, "one")?.scrollTop
  ).toBe(30)
  provider = { cacheScope: "two" } as MusicProvider
  controller.syncContext()
  older.update({ route: "/playlist/one", align })
  expect(
    controller.getHeroWinner("/playlist/one", provider, "two")
  ).toBeUndefined()
  expect(controller.store.getState().heroes).toEqual([])
})
