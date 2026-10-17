import { expect, test } from "bun:test"
import type { MusicTrack } from "../src/types/music"
import { MusicRadioSession, orderRadioUpcoming, radioTrackSource } from "../src/lib/musicRadio"

const track = (source: "plex" | "ytmusic", n: number, title = `${source} ${n}`) => {
  const id = source === "ytmusic" ? `ytmusic:${String(n).padStart(11, "0")}` : `plex:${n}`
  return { id, streamUrl: source === "ytmusic" ? id : undefined, title, artistName: "Test Artist", duration: 180_000, albumName: "Album" } as MusicTrack
}
const batch = (source: "plex" | "ytmusic", count = 80) => Array.from({ length: count }, (_, n) => track(source, n + 1))
const sourcesOf = (tracks: MusicTrack[]) => tracks.map(radioTrackSource)
const alternating = ["ytmusic", "plex", "ytmusic", "plex", "ytmusic", "plex", "ytmusic", "plex", "ytmusic", "plex"]

test("mixed radio keeps exactly ten upcoming songs, balanced and alternating across skips", async () => {
  let plexCalls = 0, youtubeCalls = 0
  const radio = new MusicRadioSession("mixed", {
    plex: { load: async () => { plexCalls++; return batch("plex") } },
    ytmusic: { load: async () => { youtubeCalls++; return batch("ytmusic") } },
  })
  let current = track("plex", 0)
  await radio.fill([], current)
  let upcoming = radio.take([], current)
  expect(sourcesOf(upcoming)).toEqual(alternating)
  for (let skip = 0; skip < 30; skip++) {
    current = upcoming.shift()!
    await radio.fill(upcoming, current)
    upcoming.push(...radio.take(upcoming, current))
    expect(upcoming).toHaveLength(10)
    expect(upcoming.filter(item => radioTrackSource(item) === "plex")).toHaveLength(5)
    expect(upcoming.filter(item => radioTrackSource(item) === "ytmusic")).toHaveLength(5)
    expect(new Set([current.id, ...upcoming.map(item => item.id)]).size).toBe(11)
    expect(radioTrackSource(upcoming[0])).not.toBe(radioTrackSource(current))
    for (let i = 1; i < upcoming.length; i++) expect(radioTrackSource(upcoming[i])).not.toBe(radioTrackSource(upcoming[i - 1]))
  }
  // Remaining recommendations are held in small service buffers, not fetched on every skip.
  expect(plexCalls).toBe(1)
  expect(youtubeCalls).toBe(1)
})

for (const source of ["plex", "ytmusic"] as const) {
  test(`${source} radio publishes ten songs from that service only`, async () => {
    const radio = new MusicRadioSession(source, { [source]: { load: async () => batch(source) } })
    await radio.fill([], null)
    const upcoming = radio.take([], null)
    expect(upcoming).toHaveLength(10)
    expect(sourcesOf(upcoming).every(item => item === source)).toBe(true)
    expect(radio.take(upcoming, null)).toEqual([])
  })
}

test("service failure preserves the other quota, backs off, and can be retried", async () => {
  let fail = true, calls = 0
  const radio = new MusicRadioSession("mixed", {
    plex: { load: async () => { calls++; if (fail) throw Error("offline"); return batch("plex") } },
    ytmusic: { load: async () => batch("ytmusic") },
  })
  const current = track("plex", 0)
  await radio.fill([], current)
  let upcoming = radio.take([], current)
  expect(upcoming).toHaveLength(5)
  expect(sourcesOf(upcoming)).toEqual(Array(5).fill("ytmusic"))
  expect(radio.error).toContain("Plex")
  await radio.fill(upcoming, current)
  expect(calls).toBe(1)
  fail = false
  radio.retry()
  await radio.fill(upcoming, current)
  upcoming = orderRadioUpcoming("mixed", [...upcoming, ...radio.take(upcoming, current)], current)
  expect(sourcesOf(upcoming)).toEqual(alternating)
  expect(radio.error).toBeNull()
})

test("radio excludes the seed and the same recording from either service", async () => {
  const seed = track("plex", 1, "Seed")
  const radio = new MusicRadioSession("mixed", {
    plex: { load: async () => [seed, track("plex", 2, "Same recording"), ...batch("plex").slice(2)] },
    ytmusic: { load: async () => [track("ytmusic", 1, "Seed"), track("ytmusic", 2, "Same recording"), ...batch("ytmusic").slice(2)] },
  })
  await radio.fill([], seed)
  const upcoming = radio.take([], seed)
  expect(upcoming).toHaveLength(10)
  expect(upcoming.some(item => item.title === "Seed")).toBe(false)
  expect(upcoming.filter(item => item.title === "Same recording")).toHaveLength(1)
})

test("late recommendations are discarded after retirement or an account change", async () => {
  for (const retire of [true, false]) {
    let finish!: (tracks: MusicTrack[]) => void
    let owns = true
    const radio = new MusicRadioSession("plex", { plex: { load: () => new Promise(resolve => { finish = resolve }) } }, () => owns)
    const pending = radio.fill([], null)
    if (retire) radio.retire()
    else owns = false
    finish(batch("plex"))
    await pending
    expect(radio.take([], null)).toEqual([])
  }
})

test("rewinding or recovering a partial window restores the cap and source order", () => {
  const tracks = [...batch("plex", 20), ...batch("ytmusic", 20)]
  expect(sourcesOf(orderRadioUpcoming("mixed", tracks, track("plex", 0)))).toEqual(alternating)
  expect(sourcesOf(orderRadioUpcoming("ytmusic", tracks, null))).toEqual(Array(10).fill("ytmusic"))
})
