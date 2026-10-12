import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useLocation } from "wouter"
import { useNotificationCenterStore } from "../stores/notificationCenterStore"

interface ListeningStatus {
  pending: number
  unretained: number
  save_failed: boolean
  waiting_for_account: number
  retrying: number
  delayed: number
}

/** Publishes confirmed listening problems; ordinary delivery never raises a notice. */
export function ListeningSyncStatus() {
  const [status, setStatus] = useState<ListeningStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(false)
  const retryInFlight = useRef(false)
  const revision = useRef(0)
  const notify = useNotificationCenterStore((s) => s.notify)
  const resolve = useNotificationCenterStore((s) => s.resolve)
  const [, navigate] = useLocation()

  const readStatus = useCallback(async () => {
    if (!mounted.current) return
    const request = ++revision.current
    try {
      const result = await invoke<ListeningStatus>("listening_history_status")
      if (mounted.current && request === revision.current) {
        setStatus(result)
        setFailed(false)
      }
    } catch {
      if (mounted.current && request === revision.current) {
        setFailed(true)
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
        setFailed(true)
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
    if (failed) {
      notify({
        id: "listening.status",
        title: "Listening status unavailable",
        message:
          "Unable to check listening history. This does not mean saved history was lost.",
        severity: "warning",
        persistent: true,
        action: {
          label: "Check status",
          run: async () => {
            if (!retryInFlight.current) await readStatus()
          },
        },
      })
    } else {
      resolve("listening.status")
    }
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
    if (status.delayed > 0) {
      notify({
        id: "listening.sync",
        title: "Scrobbling delayed",
        message:
          "Listening history is saved locally. Sync is delayed and will retry automatically.",
        severity: "warning",
        persistent: true,
        action: { label: "Retry now", run: retry },
      })
    } else {
      resolve("listening.sync")
    }
    if (status.waiting_for_account > 0) {
      notify({
        id: "listening.accounts",
        title: "Scrobbling account disconnected",
        message:
          "Some listening history is saved for an account, library, or integration that isn’t active.",
        severity: "info",
        persistent: true,
        action: {
          label: "Settings",
          run: async () => {
            if (mounted.current) navigate("/settings")
          },
        },
      })
    } else {
      resolve("listening.accounts")
    }
  }, [status, failed, notify, resolve, readStatus, retry, navigate])

  return null
}
