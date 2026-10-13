import { test, expect } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { JSDOM } from "jsdom"
import { WeeklyEditionHistory } from "../src/components/PlaylistSync/WeeklyEditionHistory"
import type { WeeklyEditionReceipt } from "../src/playlistSync/weekly"
const receipt: WeeklyEditionReceipt = {
  edition: {
    playlistId: "old",
    family: "weekly-jams",
    recipient: "listener",
    createdAt: "2026-10-05T05:00:00Z",
    weekOf: "2026-10-05",
  },
  sourceHash: "a".repeat(64),
  finishedAt: 1,
  total: 50,
  matchedCount: 31,
  missingOccurrences: [
    {
      occurrenceId: "older-one",
      track: {
        id: "remote",
        title: '<img src="private">',
        artist: "Earlier artist",
      },
    },
  ],
}
test("earlier weekly unresolved rows retain their edition, counts and safe text separately", () => {
  const doc = new JSDOM(
    renderToStaticMarkup(
      <WeeklyEditionHistory
        receipts={[
          receipt,
          {
            ...receipt,
            edition: { ...receipt.edition, playlistId: "complete" },
            missingOccurrences: [],
          },
        ]}
      />
    )
  ).window.document
  expect(doc.querySelectorAll("details").length).toBe(1)
  expect(doc.querySelector("summary")!.textContent).toBe(
    "Week of 2026-10-05 · 1 song needs review"
  )
  expect(doc.body.textContent).toContain(
    "31 of 50 songs matched in this edition."
  )
  expect(doc.querySelectorAll("li").length).toBe(1)
  expect(doc.querySelector("li")!.textContent).toContain('<img src="private">')
  expect(doc.querySelector("img")).toBeNull()
  expect(doc.body.textContent).toContain(
    "kept separately from the current sync"
  )
})
test("missing optional counts do not invent totals and absent dates use generation date", () => {
  const html = renderToStaticMarkup(
    <WeeklyEditionHistory
      receipts={[
        {
          ...receipt,
          total: undefined,
          matchedCount: undefined,
          edition: { ...receipt.edition, weekOf: null },
        },
      ]}
    />
  )
  expect(html).toContain("Generated 2026-10-05")
  expect(html).not.toContain("songs matched in this edition")
  expect(renderToStaticMarkup(<WeeklyEditionHistory receipts={[]} />)).toBe("")
})
