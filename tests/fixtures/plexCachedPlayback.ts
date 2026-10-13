import assert from "node:assert/strict"
import { PlexProvider } from "../../src/backends/plex/provider"
import type { PlexTransport } from "../../src/backends/plex/scopedApi"
const scenario = process.argv[2]
const calls: { command: string; args: any }[] = []
let resolve!: (value: any) => void
const pending = new Promise<any>((r) => (resolve = r))
const raw = {
  rating_key: 7,
  parent_key: "/library/metadata/2",
  media: [
    {
      id: 1,
      audio_codec: "flac",
      parts: [
        {
          id: 100,
          key: "/library/parts/100/audio.flac",
          streams: [
            {
              stream_type: 2,
              start_ramp: "fresh start",
              end_ramp: "fresh end",
            },
          ],
        },
      ],
    },
  ],
}
const transport: PlexTransport = async (command, args) => {
  calls.push({ command, args })
  if (command === "get_track") {
    if (scenario === "unavailable")
      throw new Error("https://private.test/file?token=secret")
    if (scenario === "retired") return pending
    return raw as any
  }
  if (command === "get_stream_url" || command === "get_audio_transcode_url")
    return "https://fixture.test/owned-audio" as any
  throw new Error("Unexpected request")
}
const scope = "plex-" + "a".repeat(64)
const provider = new PlexProvider(transport)
await provider.connect({
  baseUrl: "https://fixture.test",
  token: "synthetic-only",
  sectionId: 1,
  sectionUuid: "library",
  machineIdentifier: "server",
  cacheScope: scope,
  connectionRevision: 1,
})
const cached: any = {
  id: "7",
  title: "Saved track",
  streamUrl: null,
  mediaInfo: {
    metadataComplete: true,
    hasAudioStream: true,
    versions: [{ mediaId: "fake", partId: "999", codec: "flac" }],
  },
}
if (scenario === "success") {
  const direct = await provider.getPlaybackInfo(cached)
  assert.equal(direct.partId, 100)
  assert.equal(direct.parentKey, raw.parent_key)
  assert.equal(direct.startRamp, "fresh start")
  assert.equal(direct.url, "https://fixture.test/owned-audio")
  const stream = await provider.getStreamUrl(cached)
  assert.equal(stream, direct.url)
  const transcoded = await provider.getTranscodePlaybackInfo(cached)
  assert.equal(transcoded.partId, 100)
  assert.equal(calls.filter((call) => call.command === "get_track").length, 3)
  assert(
    calls
      .filter((call) => call.command !== "get_track")
      .every((call) => call.args.partKey === "/library/parts/100/audio.flac")
  )
  assert(
    calls.every(
      (call) =>
        call.args.context.cacheScope === scope &&
        call.args.context.connectionRevision === 1
    )
  )
} else if (scenario === "unavailable") {
  for (const request of [
    () => provider.getPlaybackInfo(cached),
    () => provider.getStreamUrl(cached),
    () => provider.getTranscodePlaybackInfo(cached),
  ]) {
    try {
      await request()
      assert.fail("Playback cannot be reconstructed from browsing DTO")
    } catch (error) {
      assert(error instanceof Error)
      assert(error.message.includes("Reconnect to Plex"))
      assert(!error.message.includes("secret"))
      assert(!error.message.includes("private.test"))
      assert(!(error instanceof TypeError))
    }
  }
  assert(calls.every((call) => call.command === "get_track"))
} else if (scenario === "retired") {
  const playback = provider.getPlaybackInfo(cached)
  await provider.disconnect()
  await provider.connect({
    baseUrl: "https://fixture.test",
    token: "replacement",
    sectionId: 1,
    cacheScope: "plex-" + "b".repeat(64),
    connectionRevision: 2,
  })
  resolve(raw)
  await assert.rejects(playback, /superseded/)
  assert.deepEqual(
    calls.map((call) => call.command),
    ["get_track"]
  )
} else throw new Error("Unknown scenario")
