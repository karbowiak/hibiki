import { expect, test } from "bun:test"
import {
  createPlexApi,
  type PlexTransport,
} from "../src/backends/plex/scopedApi"
import { PlexProvider } from "../src/backends/plex/provider"
import { deferred } from "./helpers/radioAudioFakes"
import type { Track } from "../src/backends/plex/types"

const scope = (key: string) => `plex-${key.repeat(64)}`
const context = (revision = 1, key = "a") => ({
  connectionRevision: revision,
  cacheScope: scope(key),
})
const configuration = (revision = 1, key = "a") => ({
  ...context(revision, key),
  baseUrl: "https://server.test",
  token: "dummy-token",
  sectionId: 1,
  sectionUuid: "library",
  machineIdentifier: "server",
})
const rawTrack = (key = 7) =>
  ({
    rating_key: key,
    title: "Track",
    duration: 180000,
    parent_key: "/library/metadata/1",
    media: [
      {
        audio_codec: "flac",
        parts: [{ id: 9, key: "/library/parts/9/file.flac", streams: [] }],
      },
    ],
  }) as Track

function transportHarness(
  handler: (command: string, args: any) => unknown = () => undefined
) {
  const calls: { command: string; args: any }[] = []
  const invoke = (async (command: string, args: any) => {
    calls.push({ command, args })
    return handler(command, args)
  }) as PlexTransport
  return { calls, invoke }
}

test("provider RPCs retain a copied connection and library context across caller mutation", async () => {
  const owner = context()
  const { calls, invoke } = transportHarness()
  const api = createPlexApi(owner, invoke)
  owner.connectionRevision = 2
  owner.cacheScope = scope("b")
  await api.getTrack(7)
  await api.deletePlaylist(7)
  await api.reportTimeline(7, "playing", 25000, 180000)
  await api.getAudioTranscodeUrl("/library/parts/9/file", 320, "mp3")
  await api.updateNowPlaying("Track", "Artist", "Album", null, 180000)
  await api.setNowPlayingState("paused", 25000)
  expect(calls.map((call) => call.command)).toEqual([
    "get_track",
    "delete_playlist",
    "report_timeline",
    "get_audio_transcode_url",
    "update_now_playing",
    "set_now_playing_state",
  ])
  expect(
    calls.every(
      (call) => JSON.stringify(call.args.context) === JSON.stringify(context())
    )
  ).toBe(true)
  expect(calls.every((call) => !("token" in call.args.context))).toBe(true)
})

test("retiring a provider prevents a new RPC and discards an in-flight response", async () => {
  let owns = true
  const pending = deferred<Track>()
  const { calls, invoke } = transportHarness(() => pending.promise)
  const api = createPlexApi(context(), invoke, () => owns)
  const old = api.getTrack(7)
  owns = false
  await expect(api.rateItem(7, 5)).rejects.toThrow("superseded")
  pending.resolve(rawTrack())
  await expect(old).rejects.toThrow("superseded")
  expect(calls.length).toBe(1)
})

test("invalid native ownership is rejected without invoking a command", () => {
  const { calls, invoke } = transportHarness()
  for (const owner of [
    context(-1),
    context(NaN),
    { ...context(), cacheScope: "" },
  ]) {
    expect(() => createPlexApi(owner, invoke)).toThrow(
      "Invalid Plex connection context"
    )
  }
  expect(calls.length).toBe(0)
})

test("an actual disconnected PlexProvider cannot delete or rate items through the replacement client", async () => {
  const { calls, invoke } = transportHarness()
  const old = new PlexProvider(invoke)
  await old.connect(configuration())
  await old.deletePlaylist("7")
  await old.disconnect()
  const next = new PlexProvider(invoke)
  await next.connect(configuration(2, "b"))
  await expect(old.deletePlaylist("7")).rejects.toThrow("disconnected")
  await expect(old.rate("7", 10)).rejects.toThrow("disconnected")
  await next.rate("7", 5)
  expect(calls.map((call) => call.args.context)).toEqual([
    context(),
    context(2, "b"),
  ])
})

test("playback metadata falling back after retirement cannot resolve a URL from a reconnected provider", async () => {
  const pending = deferred<Track>()
  const { calls, invoke } = transportHarness((command) => {
    if (command === "get_track") return pending.promise
    if (command === "get_stream_url") return "https://server.test/file"
  })
  const provider = new PlexProvider(invoke)
  await provider.connect(configuration())
  const playback = provider.getPlaybackInfo({
    id: "7",
    _providerData: rawTrack(),
  } as any)
  await provider.disconnect()
  await provider.connect(configuration(2, "b"))
  pending.resolve(rawTrack())
  await expect(playback).rejects.toThrow("superseded")
  expect(calls.map((call) => call.command)).toEqual(["get_track"])
  expect(calls[0].args.context).toEqual(context())
})

test("direct and transcoded playback URLs use the bound native client", async () => {
  const { calls, invoke } = transportHarness((command) =>
    command === "get_stream_url"
      ? "https://server.test/direct"
      : "https://server.test/transcoded"
  )
  const provider = new PlexProvider(invoke)
  await provider.connect(configuration())
  const track = {
    id: "7",
    mediaInfo: { metadataComplete: true },
    _providerData: rawTrack(),
  } as any
  const direct = await provider.getPlaybackInfo(track)
  expect(direct.url).toBe("https://server.test/direct")
  expect(direct.plexContext).toEqual(context())
  const transcoded = await provider.getTranscodePlaybackInfo(track)
  expect(transcoded.url).toBe("https://server.test/transcoded")
  expect(transcoded.plexContext).toEqual(context())
  expect(calls.map((call) => call.command)).toEqual([
    "get_stream_url",
    "get_audio_transcode_url",
  ])
  expect(
    calls.every((call) => call.args.context.cacheScope === scope("a"))
  ).toBe(true)
  expect(calls[1].args.partKey).toBe("/library/parts/9/file.flac")
})
