import { expect, test } from "bun:test"
import { discoveryPages } from "../src/lib/discoveryPages"

test("revalidation replaces loaded pages and retires a changed continuation chain", () => {
  const pages = discoveryPages<{ id: string }>(item => item.id)
  pages.set(null, { items: [{ id: "first" }], next: "old" })
  pages.set("old", { items: [{ id: "tail" }], next: undefined })
  expect(pages.read()?.items.map(item => item.id)).toEqual(["first", "tail"])
  pages.set(null, { items: [{ id: "fresh" }], next: "new" })
  expect(pages.read()?.items.map(item => item.id)).toEqual(["fresh"])
  expect(pages.read()?.next).toBe("new")
  pages.set("new", { items: [{ id: "fresh" }, { id: "new-tail" }], next: undefined })
  expect(pages.read()?.items.map(item => item.id)).toEqual(["fresh", "new-tail"])
})

test("a repeated token or a duplicate continuation page ends paging", () => {
  const pages = discoveryPages<{ id: string }>(item => item.id)
  pages.set(null, { items: [{ id: "song" }], next: "one" })
  pages.set("one", { items: [{ id: "song" }], next: "two" })
  expect(pages.read()?.next).toBeUndefined()
  pages.set("one", { items: [{ id: "second" }], next: "one" })
  expect(pages.read()?.next).toBeUndefined()
})

test("ordered collections preserve repeated songs and continue through repeated-only pages", () => {
  const pages = discoveryPages<{ id: string }>(item => item.id, true)
  pages.set(null, { items: [{ id: "A" }, { id: "B" }, { id: "A" }], next: "one" })
  pages.set("one", { items: [{ id: "A" }], next: "two" })
  expect(pages.read()?.next).toBe("two")
  pages.set("two", { items: [{ id: "C" }], next: "one" })
  expect(pages.read()?.items.map(item => item.id)).toEqual(["A", "B", "A", "A", "C"])
  expect(pages.read()?.next).toBeUndefined()
})
