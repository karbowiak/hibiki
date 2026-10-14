import * as nativeApi from "@tauri-apps/api/core"

type Timing = { operation: string; phase: string; durationMs: number }
const pending: Timing[] = []
let scheduled = false
/** Development timings contain only fixed operation labels, never arguments. */
export function recordTiming(
  operation: string,
  phase: string,
  durationMs: number
) {
  if (!import.meta.env?.DEV || !nativeApi.isTauri?.()) return
  if (pending.length < 128) pending.push({ operation, phase, durationMs })
  if (scheduled) return
  scheduled = true
  setTimeout(() => {
    scheduled = false
    const events = pending.splice(0)
    void nativeApi.invoke("record_performance", { events }).catch(() => {})
  }, 250)
}
export function startTiming(operation: string) {
  const start = performance.now()
  let previous = start
  return {
    phase(name: string) {
      const now = performance.now()
      recordTiming(operation, name, now - previous)
      previous = now
    },
    end(phase = "total") {
      recordTiming(operation, phase, performance.now() - start)
    },
  }
}
