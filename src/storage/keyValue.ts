export type Namespace = "keyval" | "playlist-sync" | "local"
export interface StoredRecord { revision: number; value: string | null }
export interface StorageTransport {
  read(namespace: Namespace, key: string): Promise<StoredRecord>
  write(namespace: Namespace, key: string, value: string | null, expectedRevision: number): Promise<boolean>
  local(): Promise<[string, string][]>
}
export interface ClientStore { namespace: Namespace }
export const defaultStore: ClientStore = { namespace: "keyval" }
export const localStore: ClientStore = { namespace: "local" }

/** Reducers may be retried against a newer committed value. No cross-worker
 * read/modify/write window can overwrite a newer receipt or preference patch. */
export class SqliteKeyValue {
  constructor(readonly transport: StorageTransport) {}
  async get<T>(key: string, store = defaultStore): Promise<T | undefined> {
    const row = await this.transport.read(store.namespace, key)
    return row.value === null ? undefined : JSON.parse(row.value) as T
  }
  async update<T>(key: string, transform: (value: T | undefined) => T, store = defaultStore): Promise<void> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const row = await this.transport.read(store.namespace, key)
      const next = transform(row.value === null ? undefined : JSON.parse(row.value))
      const value = next === undefined ? null : JSON.stringify(next)
      if (await this.transport.write(store.namespace, key, value, row.revision)) return
    }
    throw Error("Saved data changed repeatedly. Please retry.")
  }
  set<T>(key: string, value: T, store = defaultStore) {
    return this.update<T>(key, () => value, store)
  }
  del(key: string, store = defaultStore) {
    return this.update<undefined>(key, () => undefined, store)
  }
}

/** Browser-only previews/tests have no native runtime and keep session data in
 * memory. The desktop application always uses the native SQLite transport. */
export function memoryTransport(): StorageTransport {
  const records = new Map<string, StoredRecord>()
  const identity = (namespace: Namespace, key: string) => JSON.stringify([namespace, key])
  return {
    async read(namespace, key) { return { ...(records.get(identity(namespace, key)) ?? { revision: 0, value: null }) } },
    async write(namespace, key, value, expectedRevision) {
      const id = identity(namespace, key), old = records.get(id)
      if ((old?.revision ?? 0) !== expectedRevision) return false
      records.set(id, { revision: expectedRevision + 1, value })
      return true
    },
    async local() {
      return [...records].flatMap(([id, row]) => {
        const [namespace, key] = JSON.parse(id)
        return namespace === "local" && row.value !== null ? [[key, row.value] as [string, string]] : []
      })
    },
  }
}
