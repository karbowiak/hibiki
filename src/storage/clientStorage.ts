import { invoke, isTauri } from "@tauri-apps/api/core"
import { SqliteKeyValue, memoryTransport, localStore, type ClientStore, type StorageTransport } from "./keyValue"
import type { PersistenceIssue } from "../stores/preferencePersistence"

const native: StorageTransport = {
  read: (namespace, key) => invoke("client_storage_read", { namespace, key }),
  write: (namespace, key, value, expectedRevision) => invoke("client_storage_write", { namespace, key, value, expectedRevision }),
  local: () => invoke("client_storage_local"),
}
// Selection happens at call time: the worker installs its IPC bridge before
// importing domain stores. Importing this module never starts a storage request.
const preview = memoryTransport()
const transport: StorageTransport = {
  read: (...args) => (isTauri() ? native : preview).read(...args),
  write: (...args) => (isTauri() ? native : preview).write(...args),
  local: () => (isTauri() ? native : preview).local(),
}
export const clientStorage = new SqliteKeyValue(transport)
export const get = <T = unknown>(key: string, store?: ClientStore) => clientStorage.get<T>(key, store)
export const set = <T>(key: string, value: T, store?: ClientStore) => clientStorage.set(key, value, store)
export const update = <T>(key: string, transform: (value: T | undefined) => T, store?: ClientStore) => clientStorage.update(key, transform, store)
export const del = (key: string, store?: ClientStore) => clientStorage.del(key, store)
export function createStore(database: string, _objectStore: string): ClientStore {
  if (database !== "hibiki-playlist-sync") throw Error("Unknown application store")
  return { namespace: "playlist-sync" }
}

const localValues = new Map<string, string>()
const pending = new Map<string, { value: string | null }>()
const writing = new Map<string, Promise<void>>()
const failed = new Set<string>(), subscribers = new Set<() => void>()
let issues: PersistenceIssue[] = []
const inWorker = () => !!(globalThis as any).__HIBIKI_BACKGROUND_WORKER__
function notify() {
  const next: PersistenceIssue[] = [...failed].map(key => ({ key, operation: "write", hasPendingChanges: true }))
  if (JSON.stringify(next) === JSON.stringify(issues)) return
  issues = next
  subscribers.forEach(callback => callback())
}
function drain(key: string) {
  if (writing.has(key)) return
  const work = (async () => {
    while (pending.has(key)) {
      const intent = pending.get(key)!
      try {
        if (intent.value === null) await del(key, localStore)
        else await set(key, intent.value, localStore)
        if (pending.get(key) === intent) pending.delete(key)
        failed.delete(key)
      } catch {
        // Keep the newest intention for Retry and the shutdown durability gate.
        failed.add(key)
        break
      }
    }
  })().finally(() => { writing.delete(key); notify() })
  writing.set(key, work)
}
export const subscribeClientStorage = (callback: () => void) => { subscribers.add(callback); return () => { subscribers.delete(callback) } }
export const clientStorageIssues = () => issues
export async function flushClientStorage() {
  while (writing.size) await Promise.all([...writing.values()])
  if (pending.size) throw Error("Some preferences could not be saved. Retry before closing Hibiki.")
}
export async function retryClientStorage() {
  for (const key of pending.keys()) drain(key)
  await flushClientStorage()
}
/** Synchronous reads use a startup snapshot for first-paint preferences.
 * Writes are coalesced in SQLite and included in normal graceful shutdown. */
export const sqliteLocalStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem: key => localValues.get(key) ?? null,
  setItem(key, value) {
    localValues.set(key, String(value))
    if (inWorker()) return
    pending.set(key, { value: String(value) }); drain(key)
  },
  removeItem(key) {
    localValues.delete(key)
    if (inWorker()) return
    pending.set(key, { value: null }); drain(key)
  },
}
export function refreshLocalPreference(key: string, value: string | null) {
  if (pending.has(key)) return
  if (value === null) localValues.delete(key)
  else localValues.set(key, value)
}

let initialized: Promise<void> | undefined
export function initializeClientStorage() {
  if (initialized) return initialized
  const work = (async () => {
    for (const [key, raw] of await transport.local()) {
      const value: unknown = JSON.parse(raw)
      if (typeof value !== "string") throw Error("Saved preferences could not be loaded.")
      localValues.set(key, value)
    }
  })()
  initialized = work
  void work.catch(() => { if (initialized === work) initialized = undefined })
  return work
}
