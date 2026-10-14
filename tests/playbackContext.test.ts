import { describe, expect, test, mock } from "bun:test"
import {
  isAlbumPlayback,
  selectReplayGain,
  preparedReplayGain,
} from "../src/audio/playbackContext"
import { createMediaPlayController } from "../src/lib/mediaPlay"
import type { MusicItem, MusicTrack } from "../src/types/music"
import type { MusicProvider } from "../src/providers/types"

function makeOnPlay(item: MusicItem, store: any) {
  return createMediaPlayController({
    getProvider: () => store.provider,
    captureSelection: () => () => true,
    reportError() {},
  })(item, store)
}

describe("explicit album playback", () => {
  const track = { albumId: "album-1", gain: -2, albumGain: -5 }
  test("a mix uses track normalization even when all its songs share an album", () => {
    expect(isAlbumPlayback(track, null)).toBe(false)
    expect(selectReplayGain(track, null)).toBe(-2)
    expect(selectReplayGain(track, "another-album")).toBe(-2)
  })
  test("the deliberately selected album uses album gain with track gain as fallback", () => {
    expect(isAlbumPlayback(track, "album-1")).toBe(true)
    expect(selectReplayGain(track, "album-1")).toBe(-5)
    expect(selectReplayGain({ ...track, albumGain: null }, "album-1")).toBe(-2)
  })
  test("fresh preparation gain reaches play/preload without losing deliberate album intent", () => {
    const prepared = { trackGain: -3, albumGain: -7 }
    expect(preparedReplayGain(track, prepared, null, null)).toBe(-3)
    expect(preparedReplayGain(track, prepared, "album-1", -2)).toBe(-7)
    expect(preparedReplayGain(track, prepared, "other-album", -2)).toBe(-3)
    expect(preparedReplayGain(track, { albumGain: -7 }, null, null)).toBeNull()
    expect(preparedReplayGain(track, { trackGain: 0 }, null, -2)).toBe(0)
    expect(
      preparedReplayGain(
        track,
        { trackGain: Infinity, albumGain: NaN },
        "album-1",
        -2
      )
    ).toBe(-2)
    expect(preparedReplayGain(track, {}, null, Infinity)).toBeNull()
  })
  test("album card playback passes explicit intent, while artist and track actions do not", () => {
    const playFromUri = mock(async (..._args: unknown[]) => {})
    const playTrack = mock(async (..._args: unknown[]) => {})
    const store = {
      playFromUri,
      playTrack,
      playPlaylist: mock(async () => {}),
      provider: { buildItemUri: (key: string) => key } as MusicProvider,
    }
    makeOnPlay(
      { id: "album-1", type: "album", title: "Album" } as MusicItem,
      store
    )!()
    expect(playFromUri.mock.calls[0][4]).toBe("album-1")
    makeOnPlay(
      { id: "artist-1", type: "artist", title: "Artist" } as MusicItem,
      store
    )!()
    expect(playFromUri.mock.calls[1][4]).toBeUndefined()
    makeOnPlay(
      { ...track, id: "track-1", type: "track" } as MusicItem,
      store
    )!()
    expect(playTrack.mock.calls[0][4]).toBeUndefined()
  })
  test("providers without server play queues still mark an album card as album playback", async () => {
    const playTrack = mock(async (..._args: unknown[]) => {})
    const store = {
      playTrack,
      playFromUri: mock(async () => {}),
      playPlaylist: mock(async () => {}),
      provider: {
        getAlbumTracks: async () => [{ ...track, id: "track-1" } as MusicTrack],
      } as MusicProvider,
    }
    makeOnPlay(
      { id: "album-1", type: "album", title: "Album" } as MusicItem,
      store
    )!()
    await Promise.resolve()
    await Promise.resolve()
    expect(playTrack.mock.calls[0][4]).toBe("album-1")
  })
})
