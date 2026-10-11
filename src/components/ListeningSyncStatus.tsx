import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"

export function ListeningSyncStatus() {
  const [status, setStatus] = useState<{ pending: number; unretained: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [retrying, setRetrying] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const result = await invoke<{ pending: number; unretained: number }>("listening_history_status")
        if (active) { setStatus(result); setFailed(false) }
      } catch { if (active) setFailed(true) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 15000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  if (!failed && !status?.pending && !status?.unretained) return null
  const unsafe = failed || !!status?.unretained
  const retry = async () => {
    setRetrying(true)
    try {
      await invoke("retry_listening_history")
      setStatus(await invoke("listening_history_status"))
      setFailed(false)
    } catch { setFailed(true) } finally { setRetrying(false) }
  }
  return <div className="flex shrink-0 items-center gap-3 border-b border-amber-400/20 bg-amber-400/10 px-4 py-2 text-xs text-amber-100" role="status">
    <p className="flex-1">{unsafe ? "Listening history could not be saved. Keep Hibiki open and retry." : "Listening history is saved locally and waiting to sync with the original accounts."}</p>
    <button className="rounded border border-amber-200/30 px-3 py-1 disabled:opacity-50" disabled={retrying} onClick={() => void retry()}>{retrying ? "Retrying…" : "Retry"}</button>
  </div>
}
