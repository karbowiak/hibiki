import { expect, test } from "bun:test"
import { parse } from "regexparam"
import { matchRoute } from "wouter"
import { decodePodcastFeed, podcastFeedPath, PODCAST_ROUTE } from "../src/lib/podcastRoute"

test("Unicode and separator-bearing feed URLs round-trip as one actual router segment", () => {
  for (const feed of ["https://feeds.test/???", "https://feeds.test/播客/🎵.xml?title=日本語&key=a/b+c=", "https://feeds.test/café.xml", "http://feeds.test/feed?signature=%2F+%3D#episode"]) {
    const path = podcastFeedPath(feed)!
    expect(path).toMatch(/^\/podcast\/u-[A-Za-z0-9_-]+$/)
    const [matched, params] = matchRoute(parse, PODCAST_ROUTE, path)
    expect(matched).toBe(true)
    expect(decodePodcastFeed((params as any).encoded)).toBe(feed)
  }
})

test("existing ASCII and Latin1 routes retain exact feed identity, including embedded slash", () => {
  for (const feed of ["https://feeds.test/???", "https://feeds.test/café.xml", "https://feeds.test/feed?old=%2f"]) {
    const encoded = btoa(feed)
    for (const token of [encoded, encoded.replace(/=+$/, ""), encodeURIComponent(encoded)]) {
      const [matched, params] = matchRoute(parse, PODCAST_ROUTE, `/podcast/${token}`)
      expect(matched).toBe(true)
      expect(decodePodcastFeed((params as any).encoded)).toBe(feed)
    }
  }
})

test("malformed payloads, invalid UTF8, unsupported URLs and oversized inputs fail strictly", () => {
  for (const token of [undefined, "", "%", "u-", "u-Zg===", "u-!!!!", "u-a", "u-_w", "aHR0cHM6Ly9mZWVkcy50ZXN0Lw===", "aHR0cHM6Ly9mZWVkcy50ZXN0Lx==", btoa("javascript:alert(1)"), btoa("ftp://feeds.test/a"), btoa("not a URL"), btoa("https://feeds.test/\nfeed"), "u-" + "a".repeat(100000)]) {
    expect(decodePodcastFeed(token)).toBeNull()
  }
  for (const feed of ["", "javascript:alert(1)", "ftp://feeds.test/a", "not a URL", " https://feeds.test/a", "https://feeds.test/\nfeed", "https://feeds.test/\ud800", "https://feeds.test/" + "a".repeat(20000)]) expect(podcastFeedPath(feed)).toBeNull()
})
