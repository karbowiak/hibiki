import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useNotificationCenterStore } from "../stores/notificationCenterStore"
import { claimScrobbleNotice } from "../lib/scrobbleNotice"

interface ListeningStatus {
  pending: number
  unretained: number
  save_failed: boolean
  waiting_for_account: number
  retrying: number
  delayed: number
  delayed_since?: number | null
}

/** Publishes confirmed listening problems; ordinary delivery never raises a notice. */
export function ListeningSyncStatus() {
  const [status, setStatus] = useState<ListeningStatus | null>(null)
  const announced = useRef(new Set<number>())
  const mounted = useRef(false)
  const retryInFlight = useRef(false)
  const revision = useRef(0)
  const notify = useNotificationCenterStore((s) => s.notify)
  const resolve = useNotificationCenterStore((s) => s.resolve)

  const readStatus = useCallback(async () => {
    if (!mounted.current) return
    const request = ++revision.current
    try {
      const result = await invoke<ListeningStatus>("listening_history_status")
      if (mounted.current && request === revision.current) {
        setStatus(result)
      }
    } catch {
      if (mounted.current && request === revision.current) {
        throw new Error(
          "Listening history status is unavailable. Please try again."
        )
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    let active = true
    let polling = false
    const refresh = async () => {
      if (!active || polling || retryInFlight.current) return
      polling = true
      try {
        await readStatus()
      } catch {
        /* Published through the confirmed status state. */
      } finally {
        polling = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 15000)
    return () => {
      active = false
      mounted.current = false
      ++revision.current
      clearInterval(timer)
    }
  }, [readStatus])

  const retry = useCallback(async () => {
    if (!mounted.current || retryInFlight.current) return
    retryInFlight.current = true
    let request = ++revision.current
    let retried = false
    try {
      await invoke("retry_listening_history")
      retried = true
      if (mounted.current && request === revision.current) {
        request = revision.current + 1
        await readStatus()
      }
    } catch {
      if (mounted.current && request === revision.current) {
        throw new Error(
          retried
            ? "Listening history status is unavailable. Please check again."
            : "Listening history could not be retried. Please check its status."
        )
      }
    } finally {
      retryInFlight.current = false
    }
  }, [readStatus])

  useEffect(() => {
    // Archived library/account reports and routine status polling are not
    // evidence that an active scrobbling account disconnected.
    resolve("listening.status")
    resolve("listening.accounts")
    // Keep known problems until a successful read verifies their recovery.
    if (!status) return
    if (status.save_failed && status.unretained > 0) {
      notify({
        id: "listening.storage",
        title: "Listening history could not be saved",
        message:
          "Keep Hibiki open and retry to protect this listening history.",
        severity: "error",
        persistent: true,
        action: { label: "Retry", run: retry },
      })
    } else {
      resolve("listening.storage")
    }
    const since = status.delayed_since
    if (
      status.delayed > 0 &&
      since &&
      !announced.current.has(since) &&
      claimScrobbleNotice(since)
    ) {
      announced.current.add(since)
      notify({
        id: "listening.sync",
        title: "Scrobbling has been delayed for over a day",
        message:
          "Some listens have not reached an active scrobbling service after 24 hours of retries. They are saved locally; automatic retries will continue.",
        severity: "warning",
        persistent: false,
        eventKey: String(since),
        action: { label: "Retry now", run: retry },
      })
    } else if (!status.delayed || !since) {
      resolve("listening.sync")
    }
  }, [status, notify, resolve, retry])

  return null
}
