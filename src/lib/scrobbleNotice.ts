const KEY = "hibiki-scrobble-delay-notice-v1"
export const SCROBBLE_NOTICE_DELAY_MS = 24 * 60 * 60 * 1000

/** A long outage gets one dismissible notice, without replaying it on startup. */
export function claimScrobbleNotice(
  since: number,
  now = Date.now(),
  storage?: Pick<Storage, "getItem" | "setItem">
) {
  if (
    !Number.isFinite(since) ||
    since <= 0 ||
    now - since * 1000 < SCROBBLE_NOTICE_DELAY_MS
  )
    return false
  try {
    const target = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage)
    const previous = JSON.parse(target?.getItem(KEY) ?? "null")
    if (
      previous?.since === since ||
      (Number.isFinite(previous?.at) &&
        now - previous.at < SCROBBLE_NOTICE_DELAY_MS)
    )
      return false
    target?.setItem(KEY, JSON.stringify({ since, at: now }))
  } catch {
    /* The component also deduplicates notices for this app session. */
  }
  return true
}
