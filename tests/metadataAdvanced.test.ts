import { test, expect } from "bun:test"
import {
  planAdvancedMetadata,
  type AdvancedMetadata,
} from "../src/lib/metadataAdvanced"
const baseline: AdvancedMetadata = {
  itemId: 12,
  kind: "album",
  fields: {
    sortTitle: { value: "Original", locked: false },
    genres: { value: ["Rock, Pop", "日本"], locked: true },
    posterLock: { value: "opaque-fingerprint", locked: false },
    moods: { value: [], locked: null },
  },
}
test("advanced plans retain exact originals and explicit value/lock changes", () => {
  const draft = structuredClone(baseline.fields)
  draft.sortTitle = { value: "New", locked: true }
  draft.genres = { value: ["New + Genre"], locked: false }
  const plan = planAdvancedMetadata(baseline, draft)
  expect(plan.expected.genres).toEqual(baseline.fields.genres)
  expect(plan.changes.sortTitle).toEqual({ value: "New", locked: true })
  expect(Object.keys(plan.changes)).toEqual(["sortTitle", "genres"])
})
test("unknown locks, duplicate tags, and artwork URL substitution fail before transport", () => {
  expect(() =>
    planAdvancedMetadata(baseline, {
      moods: { value: ["Calm"], locked: false },
    })
  ).toThrow("explicit field lock")
  expect(() =>
    planAdvancedMetadata(baseline, {
      genres: { value: ["Rock", "Rock"], locked: true },
    })
  ).toThrow("unique")
  expect(() =>
    planAdvancedMetadata(baseline, {
      posterLock: { value: "https://private.invalid/image", locked: true },
    })
  ).toThrow("Artwork values")
  expect(
    planAdvancedMetadata(baseline, {
      posterLock: { value: "opaque-fingerprint", locked: true },
    }).changes.posterLock?.locked
  ).toBe(true)
  expect(() =>
    planAdvancedMetadata(baseline, {
      genres: { value: ["日本", "Rock, Pop"], locked: true },
    })
  ).toThrow("No advanced")
})
