import { persist, type PersistOptions } from "zustand/middleware"
import type { StateCreator } from "zustand"
import {
  isRecord,
  type PatchRules,
  type SavedState,
} from "./persistencePatches"
import { PreferencePersistence } from "./preferencePersistence"

export interface SafePersistOptions<T, P>
  extends PersistOptions<T, P>, PatchRules {
  validate?: (state: SavedState) => boolean
  hasPendingIntent?: () => boolean
}

/** Zustand hydration merges local intent before allowing any saved-data writes. */
export function persistenceMiddleware(service: PreferencePersistence) {
  return function safePersist<T, P = Partial<T>>(
    creator: StateCreator<T, [], []>,
    options: SafePersistOptions<T, P>
  ): StateCreator<T, [], [["zustand/persist", P]]> {
    const version = options.version ?? 0
    const partialize =
      options.partialize ?? ((state: T) => state as unknown as P)
    let defaults: SavedState = {}
    const validate = (saved: SavedState) => {
      for (const [key, value] of Object.entries(defaults)) {
        if (!Object.hasOwn(saved, key)) continue
        const candidate = saved[key]
        if (
          Array.isArray(value)
            ? !Array.isArray(candidate)
            : isRecord(value)
              ? !isRecord(candidate)
              : value !== null &&
                (typeof value !== typeof candidate ||
                  (typeof candidate === "number" &&
                    !Number.isFinite(candidate)))
        )
          return false
      }
      return !options.validate || options.validate(saved)
    }
    const session = service.register(options.name, options, version, validate, options.hasPendingIntent)
    return persist<T, [], [], P>(
      (set, get, api) => {
        const initial = creator(set, get, api)
        defaults = partialize(initial) as SavedState
        session.baseline(defaults)
        session.setRetry(() => (api as any).persist.rehydrate())
        return initial
      },
      {
        ...options,
        storage: {
          getItem: () =>
            session.read() as Promise<{ state: P; version?: number } | null>,
          setItem: (_name, value) => session.stage(value.state as SavedState),
          removeItem: () => session.remove(),
        },
        merge: (saved, current) => {
          const patched = session.merge(saved)
          // Retain future fields on disk without letting them replace actions or
          // other transient state in this version of the store.
          const local = Object.fromEntries(
            Object.entries(patched).filter(([key]) =>
              Object.hasOwn(defaults, key)
            )
          )
          const merged = options.merge
            ? options.merge(local, current)
            : { ...current, ...local }
          session.baseline(partialize(merged) as SavedState)
          return merged
        },
        onRehydrateStorage: (state) => {
          const finish = options.onRehydrateStorage?.(state)
          return (hydrated, error) => {
            try {
              if (typeof finish === "function") finish(hydrated, error)
            } catch (cause) {
              session.hydrated(cause)
              return
            }
            session.hydrated(error)
          }
        },
      }
    )
  }
}
