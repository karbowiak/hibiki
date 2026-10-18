import { expect, test } from "bun:test"
import { youtubeMusicTrack } from "../src/backends/ytmusic/tracks"
import { COUNTERPART_POLICY, counterpartCandidates, counterpartPending, matchPlaylistBatch, selectPlaylistCounterpart } from "../src/mixedPlaylists/matching"
import { newOccurrence, hydratePlaylist, type MixedPlaylist } from "../src/mixedPlaylists/model"
import { youtubeCounterpartCandidates } from "../src/mixedPlaylists/youtubeMatching"

const song = (patch: Partial<ReturnType<typeof youtubeMusicTrack>> = {}) => ({
  ...youtubeMusicTrack({ videoId: "a1234567890", title: "Dopamine", artist: "S3RL", album: "Dopamine", duration: "2:58", thumbnail: null }), ...patch,
})
const creditedSong = (title: string, names: string[], duration: number, id = "ytmusic:a1234567890") =>
  song({ id, title, artistName: names.join(", "), artistCredits: names.map(name => ({ name })), albumName: title.replace(/\s*\(feat\..*\)$/i, ""), duration })

test("playlist matching accepts Plex's missing collaborator credits and saves graded confidence", async () => {
  for (const [title, primary, guests, duration] of [
    ["One Last Dance", "Re-Style", ["Re-Style", "Cammie Robinson"], 219297],
    ["Halibo", "Billx", ["Billx", "Dr. Peacock"], 285599],
    ["The Gods of Tekk", "BMG", ["BMG & Minupren"], 241057],
    ["Not for Me", "Unicorn on Ketamine", ["acecore", "Unicorn On Ketamine"], 259683],
  ] as const) {
    const source = creditedSong(title, [primary], duration, "1")
    const candidate = creditedSong(title, [...guests], title === "Not for Me" ? 254000 : Math.ceil(duration / 1000) * 1000)
    const selected = selectPlaylistCounterpart(source, [candidate])!
    expect(selected.track).toEqual(candidate)
    expect(selected.confidence).toBeGreaterThan(0.9)
    const initial = hydratePlaylist({ service: "plex", id: "10", owner: "owner", title: "List", readOnly: false, items: [{ track: source, occurrenceId: "1" }] })
    const batch = await matchPlaylistBatch(initial, "ytmusic", { current: () => true, save: async value => value,
      resolve: async () => ({ status: "matched", ...selected, fingerprint: "proof", checkedAt: 1 }) })
    expect(batch.playlist.items[0].match.confidence).toBe(selected.confidence)
    expect(structuredClone(batch.playlist).items[0].match.confidence).toBe(selected.confidence)
  }
})

test("fuzzy titles and performers rank the best plausible song above weaker guesses", () => {
  const source = creditedSong("Never Die", ["Remzcore"], 201560, "1")
  const approximate = creditedSong("Never Dies", ["Remzcor"], 202000)
  const exact = creditedSong("Never Die (feat. Hyrule War)", ["Remzcore"], 202000, "ytmusic:b1234567890")
  const guess = selectPlaylistCounterpart(source, [approximate])!
  expect(guess.track).toEqual(approximate)
  expect(guess.confidence).toBeGreaterThan(0.82)
  expect(guess.confidence).toBeLessThan(0.97)
  expect(selectPlaylistCounterpart(source, [approximate, exact])?.track).toEqual(exact)
  // Exact consumers still require their original, stricter proof.
  expect(counterpartCandidates(source, [approximate, exact])).toEqual([])
})

test("equally plausible playlist suggestions choose a stable result with lower confidence", () => {
  const first = song(), second = song({ id: "ytmusic:b1234567890" })
  const unique = selectPlaylistCounterpart(song({ id: "1" }), [first])!
  const tied = selectPlaylistCounterpart(song({ id: "1" }), [first, second])!
  expect(tied.track.id).toBe(first.id)
  expect(tied.confidence).toBeLessThan(unique.confidence)
})

test("fuzzy matching still rejects unrelated artists, conflicting guests and materially different recordings", () => {
  const source = creditedSong("Disorder", ["Dr. Peacock"], 282358, "1")
  for (const candidate of [
    creditedSong("Disorder", ["Dr. Peacock", "N-Vitral"], 320000),
    creditedSong("Disorder", ["Other Artist"], 282000),
    creditedSong("Disorder (Live)", ["Dr. Peacock"], 282000),
    creditedSong("Disorder (Radio Edit)", ["Dr. Peacock"], 282000),
  ]) expect(selectPlaylistCounterpart(source, [candidate])).toBeNull()
  expect(selectPlaylistCounterpart(song({ explicit: true }), [song({ explicit: false })])).toBeNull()
  const guests = creditedSong("Never Die", ["Remzcore", "Hyrule War"], 202000)
  expect(selectPlaylistCounterpart(guests, [creditedSong("Never Die", ["Remzcore", "Other"], 202000)])).toBeNull()
})

test("fuzzy search stops early for a strong result and retains a prior guess on native string backpressure", async () => {
  let calls = 0
  const source = song({ id: "1" }), candidate = song()
  await youtubeCounterpartCandidates(source, { current: () => true, fuzzy: true, search: async () => { calls++; return [candidate] } })
  expect(calls).toBe(1)
  const approximate = song({ title: "Dopamin" })
  calls = 0
  const found = await youtubeCounterpartCandidates(source, { current: () => true, fuzzy: true, search: async () => {
    if (++calls === 1) return [approximate]
    throw "YouTube Music is rate limited. Hibiki will retry after the cooldown."
  } })
  expect(calls).toBe(2)
  expect(found).toEqual([approximate])
})

test("native string rejections leave remaining rows pending instead of failing the playlist", async () => {
  const initial = hydratePlaylist({ service: "plex", id: "10", owner: "owner", title: "List", readOnly: false,
    items: ["1", "2"].map(id => ({ track: song({ id }), occurrenceId: id })) })
  let calls = 0
  const result = await matchPlaylistBatch(initial, "ytmusic", { current: () => true, save: async value => value,
    resolve: async () => { calls++; throw "YouTube Music is rate limited. Hibiki will retry after the cooldown." } })
  expect(calls).toBe(1)
  expect(result.playlist.items.every(row => row.match.status === "pending")).toBe(true)
})

test("featured credits can move between title and artists without dropping a guest", () => {
  const source = song({ id: "1", artistName: "S3RL; Sara", artistCredits: [{ name: "S3RL" }, { name: "Sara" }] })
  const remote = song({ title: "Dopamine (feat. Sara)" })
  expect(counterpartCandidates(source, [remote])).toEqual([remote])
  expect(counterpartCandidates(remote, [source])).toEqual([source])
  expect(counterpartCandidates(source, [song({ title: "Dopamine (feat. Other)" })])).toEqual([])
  expect(counterpartCandidates(source, [song()])).toEqual([])
})

test("Plex combined artist entities, credit order and punctuation agree with full YTM credits", () => {
  const source = song({ artistName: "Re-Style x Remzcore", artistCredits: [{ name: "Re-Style x Remzcore", id: "123" }],
    _providerData: { grandparent_guid: "plex://artist/combined" } })
  const remote = song({ artistName: "Remzcore, ReStyle", artistCredits: [{ name: "Remzcore" }, { name: "ReStyle" }] })
  expect(counterpartCandidates(source, [remote])).toEqual([remote])
  expect(counterpartCandidates(source, [song({ artistName: "ReStyle", artistCredits: [{ name: "ReStyle" }] })])).toEqual([])
  expect(counterpartCandidates(source, [song({ artistName: "Re-Style, Other", artistCredits: [{ name: "Re-Style" }, { name: "Other" }] })])).toEqual([])
  const accent = song({ artistName: "Beyoncé", artistCredits: [{ name: "Beyoncé" }] })
  expect(counterpartCandidates(accent, [song({ artistName: "Beyonce", artistCredits: [{ name: "Beyonce" }] })])).toHaveLength(1)
})

test("matching preserves version, explicitness, identifier and duration fences", () => {
  const source = song()
  for (const patch of [
    { title: "Dopamine (Live)" }, { title: "Dopamine (Remix)" }, { title: "Dopamine (Radio Edit)" },
    { duration: 0 }, { duration: 190000 }, { artistName: "S3RL", artistCredits: [{ name: "S3RL" }, { name: "Sara" }] },
  ]) expect(counterpartCandidates(source, [song(patch)])).toEqual([])
  expect(counterpartCandidates(song({ explicit: true }), [song({ explicit: false })])).toEqual([])
  expect(counterpartCandidates(song({ guid: "plex://track/one" }), [song({ guid: "plex://track/two" })])).toEqual([])
  const band = song({ artistName: "Earth, Wind & Fire", artistCredits: [{ name: "Earth, Wind & Fire" }] })
  expect(counterpartCandidates(band, [song({ artistName: "Earth", artistCredits: [{ name: "Earth" }] })])).toEqual([])
})

test("ranked search stops at one verified recording and never takes the first unrelated hit", async () => {
  const source = song({ id: "1" }), exact = song()
  const calls: string[] = []
  const candidates = await youtubeCounterpartCandidates(source, { current: () => true, search: async query => {
    calls.push(query)
    return [song({ title: "Digital Dopamine", id: "ytmusic:b1234567890" }), exact]
  } })
  expect(calls).toEqual(["S3RL Dopamine"])
  expect(counterpartCandidates(source, candidates)).toEqual([exact])
})

test("a bounded primary-artist query recovers a song hidden by a verbose credit query", async () => {
  const source = song({ title: "Dopamine (feat. Sara)", id: "1" }), exact = song({ title: source.title })
  const calls: string[] = []
  const candidates = await youtubeCounterpartCandidates(source, { current: () => true, search: async query => {
    calls.push(query)
    return calls.length === 1 ? [] : [exact]
  } })
  expect(calls).toEqual(["S3RL Dopamine (feat. Sara)", "S3RL Dopamine"])
  expect(counterpartCandidates(source, candidates)).toEqual([exact])
})

test("multiple valid video identities stay ambiguous and fallback requests are capped", async () => {
  const source = song({ title: "Dopamine (feat. Sara)", id: "1" })
  const first = song({ title: source.title }), second = song({ title: source.title, id: "ytmusic:b1234567890" })
  let calls = 0
  const candidates = await youtubeCounterpartCandidates(source, { current: () => true, search: async () => { calls++; return [first, second, first] } })
  expect(calls).toBe(3)
  expect(counterpartCandidates(source, candidates)).toEqual([first, second])
})

test("retiring an account during discovery prevents both fallback requests and selection", async () => {
  let current = true, calls = 0
  await expect(youtubeCounterpartCandidates(song(), { current: () => current, search: async () => {
    calls++; current = false; return [song()]
  } })).rejects.toThrow("accounts changed")
  expect(calls).toBe(1)
})

test("old failed rows retry once in bounded batches, while fresh negative results wait", async () => {
  const initial = hydratePlaylist({ id: "10", service: "plex", owner: "owner", title: "List", readOnly: false,
    items: ["1", "2", "3"].map(id => ({ occurrenceId: id, track: song({ id }) })) })
  for (const row of initial.items) row.match = { status: "failed", checkedAt: Date.now(), message: "Search was incomplete. Retry matching." }
  expect(counterpartPending(initial.items[0], "ytmusic")).toBe(true)
  let calls = 0
  const options = { current: () => true, limit: 2, save: async (value: MixedPlaylist) => value,
    resolve: async () => { calls++; return { status: "missing" as const, checkedAt: Date.now(), message: "No current match." } } }
  const first = await matchPlaylistBatch(initial, "ytmusic", options)
  expect(first.completed).toBe(2)
  expect(first.playlist.items[0].match.policy).toBe(COUNTERPART_POLICY)
  expect(counterpartPending(first.playlist.items[0], "ytmusic")).toBe(false)
  const next = await matchPlaylistBatch(first.playlist, "ytmusic", options)
  expect(next.completed).toBe(1)
  expect(calls).toBe(3)
  expect((await matchPlaylistBatch(next.playlist, "ytmusic", options)).completed).toBe(0)
  const verified = newOccurrence(song())
  expect(counterpartPending(verified, "ytmusic")).toBe(false)
})

for (const message of ["YouTube Music is rate limited. Hibiki will retry after the cooldown.", "YouTube Music request queue is busy. Try again shortly."]) {
  test(`backpressure pauses a matching batch without recording a missing song: ${message}`, async () => {
    const initial = hydratePlaylist({ id: "10", service: "plex", owner: "owner", title: "List", readOnly: false,
      items: ["1", "2", "3"].map(id => ({ occurrenceId: id, track: song({ id }) })) })
    let calls = 0
    const paused = await matchPlaylistBatch(initial, "ytmusic", { current: () => true, save: async value => value,
      resolve: async () => { calls++; return { status: "failed", checkedAt: Date.now(), message } } })
    expect(calls).toBe(1)
    expect(paused.playlist.items.every(row => row.match.status === "pending")).toBe(true)
    const resumed = await matchPlaylistBatch(paused.playlist, "ytmusic", { current: () => true, save: async value => value,
      resolve: async track => ({ status: "matched", track: song({ id: `ytmusic:${track.id.padStart(11, "a")}` }), checkedAt: Date.now(), fingerprint: "proof" }) })
    expect(resumed.completed).toBe(3)
    expect(resumed.playlist.items.every(row => row.songs.ytmusic)).toBe(true)
  })
}
