import { invoke } from "@tauri-apps/api/core"
import type { MusicItem } from "../../types/music"
import type { MusicProvider } from "../../providers/types"
import { clearlyBetterAudio } from "../../lib/audioQuality"

type Proof = NonNullable<
  NonNullable<import("../../types/music").MediaInfo>["verifiedAudio"]
>
const proofs = new Map<
  string,
  { until: number; promise: Promise<Proof | null> }
>()
let lane = Promise.resolve()

/** Only investigate confirmed matches with clearly inferior Plex audio. Serial,
 * bounded decoder probes prove account availability without resolving all search
 * results. Signed URLs and credentials stay native. Failures quietly keep Plex. */
export async function verifySearchAudio(
  primary: MusicItem[],
  secondary: MusicItem[],
  associations: ReadonlyMap<string, string | null>,
  provider: MusicProvider,
  owner: string,
  current: () => boolean
): Promise<MusicItem[]> {
  let result = secondary
  const candidates = secondary
    .filter(
      (item) =>
        item.type === "track" &&
        primary.some(
          (local) =>
            local.type === "track" &&
            local.id === associations.get(item.id) &&
            clearlyBetterAudio(local, { codec: "aac", bitrate: 256 })
        )
    )
    .slice(0, 3)
  for (const item of candidates) {
    if (!current()) break
    const local = primary.find((row) => row.id === associations.get(item.id))!
    const full = await provider.getTrack(local.id).catch(() => null)
    if (!current()) break
    const versions = full?.mediaInfo?.versions?.filter(
      (version) => version.partCount === 1 && !!version.partId
    )
    if (
      !full ||
      full.mediaInfo?.versionsTruncated ||
      (full.mediaInfo?.versions?.length && !versions?.length) ||
      !(versions?.length ? versions : [full]).every((version) =>
        clearlyBetterAudio(version, { codec: "aac", bitrate: 256 })
      )
    )
      continue
    const key = `${owner}:${item.id}`
    let saved = proofs.get(key)
    if (!saved || saved.until <= Date.now()) {
      const promise = lane.then(async (): Promise<Proof | null> => {
        if (!current()) return null
        const proof = await invoke<{
          codec: string | null
          bitrate: number | null
          formatId: string | null
          checkedAt: number
        }>("ytmusic_test_stream", {
          videoId: item.id.replace(/^ytmusic:/, ""),
        }).catch(() => null)
        if (!proof?.codec || !proof.bitrate || !proof.formatId) return null
        return {
          codec: proof.codec,
          bitrate: proof.bitrate,
          formatId: proof.formatId,
          checkedAt: proof.checkedAt * 1000,
        }
      })
      lane = promise.then(
        () => {},
        () => {}
      )
      saved = { until: Date.now() + 30 * 60_000, promise }
      proofs.set(key, saved)
      if (proofs.size > 128) proofs.delete(proofs.keys().next().value!)
    }
    const proof = await saved.promise
    if (!current()) break
    // Use the complete Plex version evidence in the comparison, without replacing
    // source identity or mutating provider-owned search snapshots.
    if (
      proof &&
      (versions?.length ? versions : [full]).every((version) =>
        clearlyBetterAudio(version, proof)
      )
    )
      result = result.map((row) =>
        row === item && row.type === "track"
          ? {
              ...row,
              mediaInfo: { ...row.mediaInfo, verifiedAudio: proof },
              codec: proof.codec,
              bitrate: proof.bitrate,
            }
          : row
      )
  }
  return result
}
