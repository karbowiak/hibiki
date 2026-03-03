import { useState, useRef, useEffect, useMemo } from "react"
import { useVisualizerStore, type AutoCycleMode } from "../stores/visualizerStore"
import { useShallow } from "zustand/react/shallow"
import { getAllNames } from "../lib/milkdropPresets"

type Tab = "all" | "favorites" | "history"

const INTERVAL_OPTIONS = [15, 30, 45, 60, 90, 120]

export default function MilkdropPresetBrowser() {
  const {
    currentPresetName,
    favoritePresets,
    presetHistory,
    autoCycleEnabled,
    autoCycleIntervalSec,
    autoCycleMode,
    setCurrentPreset,
    toggleFavorite,
    setPresetBrowserOpen,
    setAutoCycleEnabled,
    setAutoCycleIntervalSec,
    setAutoCycleMode,
  } = useVisualizerStore(
    useShallow((s) => ({
      currentPresetName: s.currentPresetName,
      favoritePresets: s.favoritePresets,
      presetHistory: s.presetHistory,
      autoCycleEnabled: s.autoCycleEnabled,
      autoCycleIntervalSec: s.autoCycleIntervalSec,
      autoCycleMode: s.autoCycleMode,
      setCurrentPreset: s.setCurrentPreset,
      toggleFavorite: s.toggleFavorite,
      setPresetBrowserOpen: s.setPresetBrowserOpen,
      setAutoCycleEnabled: s.setAutoCycleEnabled,
      setAutoCycleIntervalSec: s.setAutoCycleIntervalSec,
      setAutoCycleMode: s.setAutoCycleMode,
    })),
  )

  const [tab, setTab] = useState<Tab>("all")
  const [query, setQuery] = useState("")
  const activeRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const allNames = getAllNames()
  const favSet = useMemo(() => new Set(favoritePresets), [favoritePresets])

  const sourceList = useMemo(() => {
    if (tab === "favorites") return favoritePresets
    if (tab === "history") return presetHistory
    return allNames
  }, [tab, allNames, favoritePresets, presetHistory])

  const filtered = useMemo(() => {
    if (!query) return sourceList
    const q = query.toLowerCase()
    return sourceList.filter((n) => n.toLowerCase().includes(q))
  }, [sourceList, query])

  // Auto-scroll to active preset on open
  useEffect(() => {
    const timer = setTimeout(() => {
      activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  return (
    <>
      {/* Backdrop */}
      <div
        className="absolute inset-0 z-20"
        onClick={() => setPresetBrowserOpen(false)}
      />
      {/* Panel */}
      <div className="absolute right-0 top-0 bottom-0 z-30 w-80 flex flex-col bg-black/90 backdrop-blur-md border-l border-white/10 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <span className="text-white font-semibold text-sm">Presets</span>
          <button
            onClick={() => setPresetBrowserOpen(false)}
            className="text-white/50 hover:text-white text-lg"
            aria-label="Close browser"
          >
            ✕
          </button>
        </div>

        {/* Auto-cycle controls */}
        <div className="px-4 py-2 border-b border-white/10 flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 text-white/70 cursor-pointer">
            <input
              type="checkbox"
              checked={autoCycleEnabled}
              onChange={(e) => setAutoCycleEnabled(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            Auto-cycle
          </label>
          {autoCycleEnabled && (
            <>
              <select
                value={autoCycleIntervalSec}
                onChange={(e) => setAutoCycleIntervalSec(Number(e.target.value))}
                className="bg-white/10 text-white/80 rounded px-1.5 py-0.5 text-xs border-none outline-none"
              >
                {INTERVAL_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}s
                  </option>
                ))}
              </select>
              <select
                value={autoCycleMode}
                onChange={(e) => setAutoCycleMode(e.target.value as AutoCycleMode)}
                className="bg-white/10 text-white/80 rounded px-1.5 py-0.5 text-xs border-none outline-none"
              >
                <option value="random">Random</option>
                <option value="sequential">Sequential</option>
              </select>
            </>
          )}
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-white/10">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search presets…"
            className="w-full bg-white/10 text-white text-sm rounded px-3 py-1.5 outline-none placeholder:text-white/30 focus:ring-1 focus:ring-[var(--accent)]"
            autoFocus
          />
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/10">
          {([
            ["all", `All (${allNames.length})`],
            ["favorites", `Favorites (${favoritePresets.length})`],
            ["history", "History"],
          ] as [Tab, string][]).map(([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${
                tab === t
                  ? "text-[var(--accent)] border-b-2 border-[var(--accent)]"
                  : "text-white/50 hover:text-white/80"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Preset list */}
        <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
          {filtered.length === 0 ? (
            <div className="text-white/30 text-sm text-center py-8">No presets found</div>
          ) : (
            filtered.map((name) => {
              const isActive = name === currentPresetName
              const isFav = favSet.has(name)
              return (
                <button
                  key={name}
                  ref={isActive ? activeRef : undefined}
                  onClick={() => setCurrentPreset(name)}
                  className={`w-full flex items-center gap-2 px-4 py-1.5 text-left text-xs transition-colors ${
                    isActive
                      ? "bg-[var(--accent)]/20 text-[var(--accent)]"
                      : "text-white/70 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleFavorite(name)
                    }}
                    className={`shrink-0 transition-colors ${
                      isFav ? "text-red-400" : "text-white/20 hover:text-white/50"
                    }`}
                    aria-label={isFav ? "Unfavorite" : "Favorite"}
                  >
                    {isFav ? "♥" : "♡"}
                  </button>
                  <span className="truncate">{name}</span>
                </button>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-white/10 text-white/30 text-xs flex justify-between">
          <span>{filtered.length} presets</span>
          <span>{favoritePresets.length} favorites</span>
        </div>
      </div>
    </>
  )
}
