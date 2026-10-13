import { expect, test } from "bun:test"
import { selectOfflineSnapshot } from "../src/offline/nativeCache"
import type { OfflineSnapshot } from "../src/offline/providerCache"
const snapshot = (count: number, cachedAt: number): OfflineSnapshot => ({
  payload: Array.from({ length: count }, (_, id) => ({ id })),
  cachedAt,
})
test("a newer incomplete catalogue cannot shrink a full visited shelf or playlist list", () => {
  const exact = snapshot(55, 100),
    partial = { ...snapshot(1, 200), catalogueComplete: false }
  expect(selectOfflineSnapshot(exact, partial)).toBe(exact)
  expect(selectOfflineSnapshot(null, partial)).toBe(partial)
})
test("complete entity memberships and full rosters retain the newest snapshot comparison", () => {
  const exact = snapshot(25, 100),
    complete = { ...snapshot(30, 200), catalogueComplete: true },
    older = { ...snapshot(30, 50), catalogueComplete: true }
  expect(selectOfflineSnapshot(exact, complete)).toBe(complete)
  expect(selectOfflineSnapshot(exact, older)).toBe(exact)
  expect(selectOfflineSnapshot(exact, null)).toBe(exact)
})
