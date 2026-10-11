/** Fence delayed reads and mutation completions independently for each setting. */
export class AuthOwnership<K extends string> {
  private revisions = new Map<K, number>()

  capture(commit = false) {
    const snapshot = new Map(this.revisions)
    return {
      owns: (key: K) =>
        (snapshot.get(key) ?? 0) === (this.revisions.get(key) ?? 0),
      filter: <T extends Partial<Record<K, unknown>>>(patch: T): Partial<T> => {
        const entries = Object.entries(patch).filter(
          ([key]) =>
            (snapshot.get(key as K) ?? 0) ===
            (this.revisions.get(key as K) ?? 0)
        )
        // Also fence reads started while this mutation was awaiting its result.
        if (commit)
          for (const [key] of entries)
            this.revisions.set(
              key as K,
              (this.revisions.get(key as K) ?? 0) + 1
            )
        return Object.fromEntries(entries) as Partial<T>
      },
    }
  }

  claim(...keys: K[]) {
    for (const key of keys)
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
    return this.capture(true)
  }
}
