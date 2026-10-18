import { initializeClientStorage, sqliteLocalStorage, flushClientStorage } from "../../src/storage/clientStorage"

// Emulate SQLite IPC before importing stores, just like desktop startup. Only
// synthetic fixture rows survive browser reloads; production has no web fallback.
const w = window as any
const rows: Record<string, { revision: number; value: string | null }> = JSON.parse(sessionStorage.getItem("fixture-client-state") ?? "{}")
async function invoke(command: string, args: any = {}) {
  const id = JSON.stringify([args.namespace, args.key])
  if (command === "client_storage_read") return { ...(rows[id] ?? { revision: 0, value: null }) }
  if (command === "client_storage_write") {
    if ((rows[id]?.revision ?? 0) !== args.expectedRevision) return false
    rows[id] = { revision: args.expectedRevision + 1, value: args.value }
    sessionStorage.setItem("fixture-client-state", JSON.stringify(rows))
    return true
  }
  if (command === "client_storage_local") return Object.entries(rows).flatMap(([id, row]) => {
    const [namespace, key] = JSON.parse(id)
    return namespace === "local" && row.value !== null ? [[key, row.value]] : []
  })
  throw Error(`Synthetic unsupported startup IPC: ${command}`)
}
let callback = 0
w.isTauri = true
w.__TAURI_INTERNALS__ = { invoke, transformCallback: () => ++callback, unregisterCallback: () => {} }
w.fixtureClientStorage = {
  invoke,
  read: (key: string) => sqliteLocalStorage.getItem(key),
  write: async (key: string, value: string) => { sqliteLocalStorage.setItem(key, value); await flushClientStorage() },
}
await initializeClientStorage()
