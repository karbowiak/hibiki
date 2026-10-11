import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { Router } from "wouter"
import { resolve } from "node:path"

const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
globalThis.window = dom.window as any
globalThis.document = dom.window.document
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const targets = [
  ["Playlist", "Playlist"], ["Home", "Home"], ["Library", "Library"],
  ["Artist", "ArtistPage"], ["Album", "AlbumPage"], ["Liked", "Liked"],
  ["LikedArtists", "LikedArtists"], ["LikedAlbums", "LikedAlbums"],
  ["Settings", "SettingsPage"], ["Radio", "RadioPage"], ["Mix", "MixPage"],
  ["Stations", "StationsPage"], ["HubPage", "HubPage"],
  ["RecentlyAddedPage", "RecentlyAddedPage"], ["TagPage", "TagPage"],
  ["InternetRadio", "InternetRadioPage"], ["Podcasts", "PodcastsPage"],
  ["PodcastDetail", "PodcastDetailPage"], ["Playlists", "Playlists"], ["Search", "Search"],
]
for (const [file, name] of targets) {
  mock.module(resolve(import.meta.dir, `../../src/components/Pages/${file}.tsx`), () => ({
    [name!]: (props: any) => <div data-child={name} data-value={props.tagName ?? props.hubId ?? props.stationType ?? ""} />,
  }))
}
mock.module("../../src/components/TopBar", () => ({ TopBar: () => null }))
const { Page } = await import("../../src/components/Page")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
let path = "/"
const location = () => [path, () => {}] as [string, (to: string) => void]
async function render(next: string, base = "") {
  path = next
  await act(async () => root.render(<Router hook={location} base={base}><Page /></Router>))
}
try {
  if (process.argv[2] === "names") {
    for (const [prefix, child] of [["/genre/genre/", "TagPage"], ["/hub/", "HubPage"], ["/radio/", "RadioPage"]]) {
      for (const name of ["100% Rock", "literal%2Fname", "R&B / Soul", "日本語 🎵", "hash#question?"]) {
        await render(prefix + encodeURIComponent(name))
        assert.equal(document.querySelector(`[data-child='${child}']`)?.getAttribute("data-value"), name)
        assert.ok(!document.querySelector('[role="alert"]'))
      }
    }
  } else if (process.argv[2] === "invalid") {
    for (const next of ["/hub/%E0%A4%A", "/genre/genre/%", "/radio/%ff", "/genre/invalid/Name", "/hub/%00hidden"]) {
      await render(next)
      assert.equal(document.querySelector('[role="alert"] a')?.getAttribute("href"), "/library")
      assert.ok(!document.querySelector('[data-child]'))
    }
  } else {
    await render("/music/genre/style/" + encodeURIComponent("100% / %2F"), "/music")
    assert.equal(document.querySelector('[data-child="TagPage"]')?.getAttribute("data-value"), "100% / %2F")
    await render("/hub/" + encodeURIComponent("100% Mix"), "/")
    assert.equal(document.querySelector('[data-child="HubPage"]')?.getAttribute("data-value"), "100% Mix")
  }
} finally {
  await act(async () => root.unmount())
  dom.window.close()
}
