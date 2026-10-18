import type { MatchResult, PlaylistTrack } from "./types"
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function recordingMbid(value: unknown): string | null {
  return typeof value === "string" && MBID.test(value)
    ? value.toLowerCase()
    : null
}
/** Keep edition/live/remix words and punctuation: these can identify different recordings. */
export function normalizeLabel(value: string) {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US")
}
function comparable(value: string) {
  return normalizeLabel(value)
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(/\b(?:feat|featuring|ft)\.?\s+/gu, " ")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ")
}
function titleLabel(value: string) {
  return comparable(
    value.replace(
      /(?:[([]\s*(?:original(?: mix| version)?|album version)\s*[)\]]|\s+[-–—]\s*(?:original(?: mix| version)?|album version)\s*$)/giu,
      ""
    )
  )
}
function versionWords(value: string) {
  return new Set(
    comparable(value).match(
      /\b(?:live|remix|mix|edit|acoustic|instrumental|karaoke|demo|extended|radio|sped|slowed|nightcore|mono|stereo|remaster(?:ed)?|bootleg|rework|vip|dub|cover|clean|explicit|version|unplugged)\b/gu
    ) ?? []
  )
}
function artistCredits(value: string): string[] {
  // Join phrases describe credited collaborators; split only outside parentheses.
  const credits: string[] = []
  let depth = 0,
    start = 0,
    scanned = 0
  const joins = /\s+(?:&|feat\.?|featuring|ft\.?|with|and|x|×)\s+|,\s*/giu
  for (const match of value.matchAll(joins)) {
    for (let i = scanned; i < match.index; i++) {
      if (value[i] === "(") depth++
      if (value[i] === ")") depth = Math.max(0, depth - 1)
    }
    scanned = match.index + match[0].length
    if (!depth) {
      credits.push(comparable(creditName(value.slice(start, match.index))))
      start = match.index + match[0].length
    }
  }
  credits.push(comparable(creditName(value.slice(start))))
  return credits.filter(Boolean)
}
function creditName(value: string) {
  // Expanded performer credits may follow a group name. Country/disambiguation
  // labels remain significant (e.g. Artist (US) versus Artist (UK)).
  return value.replace(/\s*\([^()]*(?:,|\s&\s)[^()]*\)\s*$/u, "")
}
function labels(track: PlaylistTrack) {
  let title = track.title
  const credits = artistCredits(track.artist)
  const prefix = title.match(/^(.+?)\s+[-–—]\s+(.+)$/u)
  if (
    prefix &&
    [comparable(track.artist), credits[0]].includes(comparable(prefix[1]))
  )
    title = prefix[2]
  // Feature credits move between the artist and title fields across services.
  // Retain the names so two different guests cannot collapse into one recording.
  const guests: string[] = []
  title = title.replace(
    /[([]\s*(?:feat\.?|featuring|ft\.?)\s+([^()[\]]+)[)\]]/giu,
    (_, names: string) => {
      guests.push(...artistCredits(names))
      return ""
    }
  )
  title = title.replace(
    /\s+(?:feat\.?|featuring|ft\.?)\s+(.+)$/iu,
    (_, names: string) => {
      guests.push(...artistCredits(names))
      return ""
    }
  )
  return { title: title.trim(), credits: [...new Set([...credits, ...guests])] }
}
/** A bounded search hint; identity is still decided against the original labels. */
export function playlistSearchTitle(track: PlaylistTrack): string {
  return labels(track).title
}
function recordingTitle(track: PlaylistTrack, title = labels(track).title) {
  const normalized = titleLabel(title)
  // A single named after the song may carry its version only in the release label.
  // Keep the full qualifier, including the remixer or venue, when moving it.
  const release = track.album?.match(/^(.*?)\s*([([][^)\]]*[)\]])\s*$/u)
  if (
    release &&
    titleLabel(release[1]) === normalized &&
    versionWords(release[2]).size
  )
    return titleLabel(`${title} ${release[2]}`)
  return normalized
}
function recordingVersions(track: PlaylistTrack) {
  const words = versionWords(recordingTitle(track))
  if (
    track.album &&
    /(?:[([]live\b|\blive (?:at|in|from)\b|\blive edition\b|\bunplugged\b)/iu.test(
      track.album
    )
  )
    words.add("live")
  if (track.album && /[([]\s*(?:the\s+)?remixes\s*[)\]]/iu.test(track.album))
    words.add("remix")
  if (track.album && /\bremaster(?:ed)?\b/iu.test(track.album)) {
    // Albums can carry mastering identity that their individual song labels omit.
    const qualifier = track.album.match(/[([]([^()[\]]*\bremaster(?:ed)?\b[^()[\]]*)[)\]]/iu)?.[1]
    words.add(`remaster:${comparable(qualifier ?? "remaster")}`)
  }
  return words
}
function similarity(a: string, b: string) {
  if (!a || !b) return 0
  if (a === b) return 1
  const left = Array.from(a),
    right = Array.from(b)
  if (left.length > 256 || right.length > 256) return 0
  let previous = Uint16Array.from({ length: right.length + 1 }, (_, i) => i)
  for (let i = 1; i <= left.length; i++) {
    const row = new Uint16Array(right.length + 1)
    row[0] = i
    for (let j = 1; j <= right.length; j++)
      row[j] = Math.min(
        row[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      )
    previous = row
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length)
}
/** Playlist suggestions may be fuzzy, while recording versions and numbered
 * titles still distinguish a remix, live performance or different song. */
export function playlistTitleSimilarity(source: PlaylistTrack, candidate: PlaylistTrack): number {
  const title = recordingTitle(source), other = recordingTitle(candidate)
  const versions = recordingVersions(source), otherVersions = recordingVersions(candidate)
  if (versions.size !== otherVersions.size || [...versions].some(word => !otherVersions.has(word))) return 0
  if (JSON.stringify(title.match(/\d+/gu)) !== JSON.stringify(other.match(/\d+/gu))) return 0
  return similarity(title, other)
}
/** A score ranks name similarity. Known IDs, versions and duration still fence selection. */
export function playlistCandidateScore(
  source: PlaylistTrack,
  candidate: PlaylistTrack
): number {
  const sourceMbid = recordingMbid(source.recordingMbid),
    candidateMbid = recordingMbid(candidate.recordingMbid)
  if (sourceMbid && candidateMbid) return sourceMbid === candidateMbid ? 1 : 0
  const sourceLabels = labels(source),
    otherLabels = labels(candidate)
  const title = recordingTitle(source, sourceLabels.title),
    candidateTitle = recordingTitle(candidate, otherLabels.title),
    artist = comparable(source.artist),
    candidateArtist = comparable(candidate.artist)
  if (!title || !candidateTitle || !artist || !candidateArtist) return 0
  const versions = recordingVersions(source),
    otherVersions = recordingVersions(candidate)
  if (
    versions.size !== otherVersions.size ||
    [...versions].some((word) => !otherVersions.has(word))
  )
    return 0
  // Version descriptions identify recordings: punctuation may vary, venue/remixer words cannot.
  if (versions.size && title !== candidateTitle) return 0
  const credits = sourceLabels.credits,
    otherCredits = otherLabels.credits
  const sameCredits =
    credits.length === otherCredits.length &&
    credits.every((credit) => otherCredits.includes(credit))
  if (credits.length > 1 && otherCredits.length > 1 && !sameCredits) return 0
  const onePrimary =
    credits[0] === otherCredits[0] &&
    (credits.length === 1 || otherCredits.length === 1)
  const durationKnown = !!source.durationMs && !!candidate.durationMs
  const featured = /\b(?:feat\.?|featuring|ft\.?)\s/iu.test(
    `${source.artist} ${source.title} ${candidate.artist} ${candidate.title}`
  )
  const sameAlbum =
    !!source.album &&
    !!candidate.album &&
    comparable(source.album) === comparable(candidate.album)
  const credited =
    title === candidateTitle &&
    (sameCredits || (onePrimary && (featured || durationKnown || sameAlbum)))
  const artistScore = artist === candidateArtist || credited ? 1 : 0
  // Title similarity cannot compensate for a different performer. Names are
  // identities, so spelling changes require a manual choice or a verified MBID.
  if (!artistScore) return 0
  const titleScore = similarity(title, candidateTitle)
  if (
    titleScore < 0.93 ||
    JSON.stringify(title.match(/\d+/gu)) !==
      JSON.stringify(candidateTitle.match(/\d+/gu))
  )
    return 0
  let score = 0.72 * titleScore + 0.28 * artistScore
  if (source.durationMs && candidate.durationMs) {
    const difference = Math.abs(source.durationMs - candidate.durationMs),
      shortest = Math.min(source.durationMs, candidate.durationMs)
    if (difference > 6000 || difference / shortest > 0.05) return 0
    score = Math.max(0, score - (0.2 * difference) / shortest)
  }
  return score
}
export function matchTrack(
  source: PlaylistTrack,
  candidates: readonly PlaylistTrack[]
): MatchResult {
  const mbid = recordingMbid(source.recordingMbid)
  const unique = [
    ...new Map(
      candidates.map((candidate) => [candidate.id, candidate])
    ).values(),
  ]
  const scores = unique
    .map((candidate) => ({
      candidate,
      score: playlistCandidateScore(source, candidate),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
  const matches = scores
    .filter((row) => row.score > 0.95)
    .map((row) => row.candidate)
  /* Versions and conflicting identifiers are rejected by playlistCandidateScore.
     Album names may differ between a single, an album and a compilation. */
  // Prefer an exact MBID over metadata-only candidates, but never silently choose between local editions.
  const exact = mbid
    ? matches.filter((track) => recordingMbid(track.recordingMbid) === mbid)
    : []
  let choices = exact.length ? exact : matches
  if (!exact.length && choices.length > 1) {
    const best = scores[0].score
    choices = choices.filter(
      (candidate) => best - playlistCandidateScore(source, candidate) < 0.015
    )
    const sameAlbum = source.album
      ? choices.filter(
          (candidate) =>
            candidate.album &&
            comparable(candidate.album) === comparable(source.album!)
        )
      : []
    if (sameAlbum.length) choices = sameAlbum
  }
  if (choices.length > 1) {
    const first = choices[0],
      known = new Set(
        choices
          .map((track) => recordingMbid(track.recordingMbid))
          .filter(Boolean)
      )
    const equivalent =
      known.size <= 1 &&
      choices.every(
        (track) =>
          titleLabel(track.title) === titleLabel(first.title) &&
          comparable(track.artist) === comparable(first.artist) &&
          !!track.durationMs &&
          !!first.durationMs &&
          Math.abs(track.durationMs - first.durationMs) <= 1000 &&
          (!source.durationMs ||
            Math.abs(track.durationMs - source.durationMs) <= 1000)
      )
    if (equivalent)
      choices = [
        choices.sort(
          (a, b) =>
            (source.durationMs
              ? Math.abs((a.durationMs ?? 0) - source.durationMs) -
                Math.abs((b.durationMs ?? 0) - source.durationMs)
              : 0) || a.id.localeCompare(b.id, "en", { numeric: true })
        )[0],
      ]
  }
  if (choices.length === 1)
    return {
      status: "matched",
      track: choices[0],
      by: exact.length ? "mbid" : "metadata",
      score: playlistCandidateScore(source, choices[0]),
    }
  return {
    status: choices.length ? "ambiguous" : "missing",
    candidates: choices.length
      ? choices
      : scores
          .filter((row) => row.score >= 0.7)
          .slice(0, 5)
          .map((row) => row.candidate),
  }
}
