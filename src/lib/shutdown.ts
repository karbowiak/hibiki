import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { preferencePersistence } from "../stores/sqliteStorage"
import { localPreferencePersistence } from "../stores/localPreferenceStorage"
import { preparePlaybackShutdown } from "../stores/playerStore"
import { flushQueuePersistence } from "./queuePersistence"
import { GracefulShutdown } from "./gracefulShutdown"
import { flushClientStorage, retryClientStorage } from "../storage/clientStorage"

export type ShutdownStatus = { phase: "idle" | "preparing" | "failed"; message: string }
let status: ShutdownStatus = { phase: "idle", message: "" }
const subscribers = new Set<() => void>()
let generation = 0
const publish = (value: ShutdownStatus) => { status = value; subscribers.forEach(callback => callback()) }
export const shutdownSnapshot = () => status
export const subscribeShutdown = (callback: () => void) => { subscribers.add(callback); return () => { subscribers.delete(callback) } }
const shutdown = new GracefulShutdown({
  async stopAndRetain() { await flushQueuePersistence(); await preparePlaybackShutdown(); await flushQueuePersistence() },
  async flushPreferences() {
    await Promise.all([preferencePersistence.flushForShutdown(), localPreferencePersistence.flushForShutdown()])
    await flushClientStorage()
    if ([...preferencePersistence.snapshot(), ...localPreferencePersistence.snapshot()].some(issue => issue.hasPendingChanges || issue.operation !== "read"))
      throw new Error("Some preferences could not be saved. Retry before closing Hibiki.")
  },
  flushRemote: () => invoke<{ pending: number }>("flush_listening_outbox"),
})
async function close(id: number) {
  if (status.phase === "preparing") return
  const attempt = ++generation
  publish({ phase: "preparing", message: "Saving listening history and preferences…" })
  try {
    await shutdown.prepare()
    if (attempt !== generation) return
    await invoke("complete_app_shutdown", { request: id })
  } catch (error) {
    if (attempt === generation) publish({ phase: "failed", message: error instanceof Error ? error.message : String(error) })
  }
}
export async function initializeShutdown(): Promise<() => void> {
  const cleanups: Array<() => void> = []
  try {
    const requested = await listen<number>("shutdown://requested", event => { void close(event.payload) })
    cleanups.push(requested)
    const failed = await listen<string>("shutdown://failed", event => { ++generation; publish({ phase: "failed", message: event.payload }) })
    cleanups.push(failed)
    const pending = await invoke<number | null>("shutdown_listener_ready")
    if (pending !== null) void close(pending)
    return () => { cleanups.forEach(cleanup => cleanup()) }
  } catch (error) {
    cleanups.forEach(cleanup => cleanup())
    publish({ phase: "failed", message: `Close preparation could not initialize: ${String(error)}` })
    return () => {}
  }
}
export async function keepOpen(): Promise<void> {
  ++generation
  try {
    await invoke("cancel_app_shutdown")
    publish({ phase: "idle", message: "" })
  } catch (error) {
    publish({ phase: "failed", message: `Could not resume Hibiki: ${String(error)}` })
    throw error
  }
}
export async function retryClose(): Promise<void> {
  try {
    // A timed-out native attempt is retired; initiate a fresh normal close request.
    await keepOpen()
    await preferencePersistence.retry()
    await localPreferencePersistence.retry()
    await retryClientStorage()
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    await getCurrentWindow().close()
  } catch (error) {
    publish({ phase: "failed", message: `Could not retry closing: ${String(error)}` })
  }
}
export async function prepareUpdateExit(): Promise<void> {
  const attempt = ++generation
  publish({ phase: "preparing", message: "Saving listening history and preferences before updating…" })
  try {
    await shutdown.prepare()
    if (attempt !== generation) throw new Error("Update preparation was cancelled")
    await invoke("approve_update_exit")
  } catch (error) {
    publish({ phase: "failed", message: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
