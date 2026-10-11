import { useEffect, useRef, useState, useSyncExternalStore } from "react"

import { createScalarPreference, type ScalarPreference } from "../stores/scalarPreference"

export type ColId = "artist" | "album" | "year" | "plays" | "popularity" | "label" | "bitrate" | "format" | "added_at" | "rating" | "rated_at"

export const ALL_COLUMNS: { id: ColId; label: string; defaultOn: boolean }[] = [
  { id: "artist",     label: "Artist",              defaultOn: false },
  { id: "album",      label: "Album",               defaultOn: true  },
  { id: "added_at",   label: "Date Added (Library)", defaultOn: true  },
  { id: "year",       label: "Year",                defaultOn: false },
  { id: "plays",      label: "Plays",               defaultOn: false },
  { id: "popularity", label: "Popularity",          defaultOn: false },
  { id: "label",      label: "Label",               defaultOn: false },
  { id: "bitrate",    label: "Bit Rate",            defaultOn: false },
  { id: "format",     label: "Format",              defaultOn: false },
  { id: "rating",     label: "Rating",              defaultOn: false },
  { id: "rated_at",   label: "Date Rated",          defaultOn: false },
]

const columnPreferences = new Map<string, ScalarPreference<ColId[]>>()

export function usePlaylistColumns(storageKey: string, defaultCols?: ColId[]) {
  let preference = columnPreferences.get(storageKey)
  if (!preference) {
    const defaults = defaultCols ?? ALL_COLUMNS.filter(c => c.defaultOn).map(c => c.id)
    preference = createScalarPreference(storageKey, defaults, raw => {
      const saved: unknown = JSON.parse(raw)
      if (!Array.isArray(saved) || saved.some(id => !ALL_COLUMNS.some(column => column.id === id)))
        throw new Error("Invalid column preferences")
      return [...new Set(saved)] as ColId[]
    }, value => JSON.stringify(value))
    columnPreferences.set(storageKey, preference)
  }
  const columns = useSyncExternalStore(preference.subscribe, preference.snapshot, preference.snapshot)
  function toggle(id: ColId) {
    if (!ALL_COLUMNS.some(column => column.id === id)) return
    const next = new Set(preference!.snapshot())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    preference!.set([...next])
  }
  return { visible: new Set(columns), toggle }
}

export function ColumnPicker({
  visible,
  toggle,
  columns,
}: {
  visible: Set<ColId>
  toggle: (id: ColId) => void
  columns: { id: ColId; label: string }[]
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open])

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors px-2 py-1 rounded hover:bg-hl-menu"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
          <path d="M1 3.5A.5.5 0 0 1 1.5 3h13a.5.5 0 0 1 0 1h-13A.5.5 0 0 1 1 3.5zm3 3A.5.5 0 0 1 4.5 6h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm2 3A.5.5 0 0 1 6.5 9h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5z" />
        </svg>
        Columns
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-52 rounded-md bg-app-surface shadow-xl border border-white/10 py-1">
          {columns.map(col => (
            <label
              key={col.id}
              className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-hl-menu text-sm text-gray-300"
            >
              <input
                type="checkbox"
                checked={visible.has(col.id)}
                onChange={() => toggle(col.id)}
                style={{ accentColor: "var(--accent)" }}
              />
              {col.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
