import { expect, test } from "bun:test"
import {
  metadataRefreshMessage,
  retryMetadataRefresh,
} from "../src/lib/metadataLoadError"

test("refresh warnings distinguish server failures without assuming the connection is down", () => {
  const cases = [
    ["HTTP error: 401 Unauthorized", "denied access"],
    ["HTTP error: 404 Not Found", "no longer available"],
    ["request timed out", "too long"],
    ["HTTP error: 429", "limiting requests"],
    ["Failed to parse JSON response", "couldn't read"],
    ["HTTP error: 503", "couldn't complete"],
    ["unexpected internal error", "couldn't refresh all"],
  ]
  for (const [error, expected] of cases) {
    const text = metadataRefreshMessage(
      `${error}: https://private.test?token=secret`,
      "artist"
    )!
    expect(text).toContain(expected)
    expect(text).toContain("saved artist")
    expect(text).not.toContain("private.test")
    expect(text).not.toContain("secret")
    expect(text).not.toContain("connection is available")
  }
  expect(
    metadataRefreshMessage(new Error("Album not found"), "album")
  ).toContain("This album")
})
test("retired requests don't tell the user Plex stopped answering", () => {
  expect(
    metadataRefreshMessage("Metadata request was superseded", "artist")
  ).toBeNull()
  expect(
    metadataRefreshMessage(new Error("Native owner retired"), "album")
  ).toBeNull()
  expect(metadataRefreshMessage("Saved library request was superseded", "artist")).toBeNull()
  expect(metadataRefreshMessage("Plex music library was superseded", "album")).toBeNull()
})

test("a superseded read recovers once; actual failures and retired pages never restart", async () => {
  let attempts = 0
  const value = await retryMetadataRefresh(
    async () => {
      if (++attempts === 1) throw new Error("Metadata request was superseded")
      return "current artist"
    },
    () => true
  )
  expect(value).toBe("current artist")
  expect(attempts).toBe(2)
  for (const [message, current, count] of [
    ["HTTP error: 503", true, 1],
    ["Metadata request was superseded", false, 1],
    ["Metadata request was superseded", true, 2],
  ] as const) {
    attempts = 0
    await expect(
      retryMetadataRefresh(
        async () => {
          attempts++
          throw new Error(message)
        },
        () => current
      )
    ).rejects.toThrow(message)
    expect(attempts).toBe(count)
  }
})
