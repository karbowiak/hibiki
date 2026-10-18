import { mock } from "bun:test"
import * as core from "@tauri-apps/api/core"

/** Native-shaped scalar storage for isolated preference fixtures. */
export function installLocalPreferenceBackend(values: Map<string, string>, options: { canRead?(): boolean; canWrite?(): boolean } = {}) {
  const revisions = new Map<string, number>()
  const revision = (key: string) => revisions.get(key) ?? (values.has(key) ? 1 : 0)
  mock.module("@tauri-apps/api/core", () => ({ ...core, isTauri: () => true, invoke: async (command: string, args: any) => {
    if (command === "client_storage_read") {
      if (options.canRead?.() === false) throw Error("Read unavailable")
      const value = values.get(args.key)
      return { revision: revision(args.key), value: value === undefined ? null : JSON.stringify(value) }
    }
    if (command === "client_storage_write") {
      if (options.canWrite?.() === false) throw Error("Write unavailable")
      if (revision(args.key) !== args.expectedRevision) return false
      if (args.value === null) values.delete(args.key)
      else values.set(args.key, JSON.parse(args.value))
      revisions.set(args.key, args.expectedRevision + 1)
      return true
    }
    return undefined
  } }))
}
