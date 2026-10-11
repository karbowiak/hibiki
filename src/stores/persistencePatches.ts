export type SavedState = Record<string, unknown>
export interface PatchRules {
  keyedArrays?: Record<string, string>
  replaceEmptyArrays?: string[]
}
export type StatePatch =
  | { kind: "set"; path: string[]; value: unknown }
  | { kind: "delete"; path: string[] }
  | {
      kind: "array"
      path: string[]
      key: string
      added: unknown[]
      removed: string[]
      order: string[]
    }

export const isRecord = (value: unknown): value is SavedState =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const own = (value: unknown, key: string): unknown =>
  isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined
const assign = (target: SavedState, key: string, value: unknown) =>
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
const identity = (value: unknown, key: string) =>
  key === "$value" ? value : own(value, key)
const ruleFor = (path: string[], rules: PatchRules) =>
  rules.keyedArrays?.[path.join(".")] ?? rules.keyedArrays?.[`${path[0]}.*`]

function indexed(values: unknown[], key: string): Map<string, unknown> {
  const result = new Map<string, unknown>()
  for (const value of values) {
    const id = identity(value, key)
    if (typeof id !== "string" || !id || result.has(id))
      throw new Error("Invalid saved list")
    result.set(id, value)
  }
  return result
}

/** Record local changes rather than replacing data from an unread or newer snapshot. */
export function statePatches(
  before: unknown,
  after: unknown,
  rules: PatchRules,
  path: string[] = []
): StatePatch[] {
  if (before === after) return []
  if (isRecord(after) && (before === undefined || isRecord(before))) {
    const previous = isRecord(before) ? before : {}
    const keys = new Set([...Object.keys(previous), ...Object.keys(after)])
    return [...keys].flatMap((key) =>
      Object.hasOwn(after, key)
        ? statePatches(own(previous, key), own(after, key), rules, [
            ...path,
            key,
          ])
        : [{ kind: "delete" as const, path: [...path, key] }]
    )
  }
  const key = Array.isArray(after) ? ruleFor(path, rules) : undefined
  if (key) {
    if (
      (after as unknown[]).length === 0 &&
      rules.replaceEmptyArrays?.includes(path.join("."))
    ) {
      return [{ kind: "set", path, value: [] }]
    }
    const previous = indexed(Array.isArray(before) ? before : [], key)
    const current = indexed(after as unknown[], key)
    const added = [...current]
      .filter(([id, value]) => previous.get(id) !== value)
      .map(([, value]) => value)
    const removed = [...previous.keys()].filter((id) => !current.has(id))
    const order = [...current.keys()]
    if (
      !added.length &&
      !removed.length &&
      JSON.stringify([...previous.keys()]) === JSON.stringify(order)
    )
      return []
    return [{ kind: "array", path, key, added, removed, order }]
  }
  return [{ kind: "set", path, value: after }]
}

/** Clone containers along the patch path; never mutate saved or live state. */
export function applyStatePatches(
  state: SavedState,
  patches: StatePatch[]
): SavedState {
  let result = { ...state }
  for (const patch of patches) {
    if (!patch.path.length) throw new Error("Invalid preference patch")
    const root = { ...result }
    let target = root
    for (const key of patch.path.slice(0, -1)) {
      const current = own(target, key)
      const child = isRecord(current) ? { ...current } : {}
      assign(target, key, child)
      target = child
    }
    const key = patch.path.at(-1)!
    if (patch.kind === "delete") delete target[key]
    else if (patch.kind === "set") assign(target, key, patch.value)
    else {
      const existing = own(target, key)
      if (existing !== undefined && !Array.isArray(existing))
        throw new Error("Invalid saved list")
      const values = indexed((existing as unknown[]) ?? [], patch.key)
      patch.removed.forEach((id) => values.delete(id))
      for (const value of patch.added) {
        const id = identity(value, patch.key) as string
        const previous = values.get(id)
        values.set(
          id,
          isRecord(previous) && isRecord(value)
            ? { ...previous, ...value }
            : value
        )
      }
      const order = [
        ...patch.order.filter((id) => values.has(id)),
        ...[...values.keys()].filter((id) => !patch.order.includes(id)),
      ]
      assign(
        target,
        key,
        order.map((id) => values.get(id))
      )
    }
    result = root
  }
  return result
}

/** Consecutive updates of one scalar/path can share the newest value. */
export function appendStatePatches(
  pending: StatePatch[],
  patches: StatePatch[]
): void {
  for (const patch of patches) {
    const last = pending.at(-1)
    if (
      last &&
      patch.kind !== "array" &&
      last.kind !== "array" &&
      JSON.stringify(last.path) === JSON.stringify(patch.path)
    )
      pending[pending.length - 1] = patch
    else pending.push(patch)
  }
}
