import { Checkbox } from "./shared/Checkbox"
import { Select } from "./shared/Select"
import { Button } from "./shared/Button"
import { useState, useRef, useEffect, useMemo } from "react"
import { useVisualizerStore, type AutoCycleMode } from "../stores/visualizerStore"
import { useShallow } from "zustand/react/shallow"
import { getAllNames } from "../lib/milkdropPresets"
import { PlayerPanelHeader } from "./shared/PlayerPanelHeader"
import { IconHeart } from "@tabler/icons-react"

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
      <div className="app-overlay-surface absolute right-0 top-0 bottom-0 z-30 w-[min(22rem,100%)] flex flex-col border-l border-white/10">
        {/* Header */}
        <PlayerPanelHeader title="Presets" onClose={() => setPresetBrowserOpen(false)} />

        {/* Auto-cycle controls */}
        <div className="px-4 py-2 border-b border-white/10 flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 text-white/70 cursor-pointer">
            <Checkbox
              checked={autoCycleEnabled}
              onChange={(e) => setAutoCycleEnabled(e.target.checked)}
              className="accent-(--accent)"
            />
            Auto-cycle
          </label>
          {autoCycleEnabled && (
            <>
              <Select
                aria-label="Preset auto-cycle interval"
                value={autoCycleIntervalSec}
                onChange={(e) => setAutoCycleIntervalSec(Number(e.target.value))}

              >
                {INTERVAL_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}s
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Preset auto-cycle order"
                value={autoCycleMode}
                onChange={(e) => setAutoCycleMode(e.target.value as AutoCycleMode)}

              >
                <option value="random">Random</option>
                <option value="sequential">Sequential</option>
              </Select>
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
            aria-label="Search presets"
            className="app-input w-full"
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
            <Button
              variant="bare"
              key={t}
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${
                tab === t
                  ? "text-(--accent) border-b-2 border-(--accent)"
                  : "text-white/50 hover:text-white/80"
              }`}
            >
              {label}
            </Button>
          ))}
        </div>

        {/* Preset list */}
        <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
          {filtered.length === 0 ? (
            <div className="text-white/70 text-sm text-center py-8">No presets found</div>
          ) : (
            filtered.map((name) => {
              const isActive = name === currentPresetName
              const isFav = favSet.has(name)
              return (
                <div
                  key={name}
                  className={`w-full flex items-center gap-2 px-3 text-left text-xs transition-colors ${
                    isActive
                      ? "bg-(--accent)/20 text-(--accent)"
                      : "text-white/70 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <Button
                    variant="bare"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleFavorite(name)
                    }}
                    className={`player-panel-icon transition-colors ${
                      isFav ? "text-red-400" : "text-white/60 hover:text-white"
                    }`}
                    aria-label={`${isFav ? "Unfavorite" : "Favorite"} ${name}`}
                    aria-pressed={isFav}
                  >
                    <IconHeart size={16} fill={isFav ? "currentColor" : "none"} aria-hidden="true" />
                  </Button>
                  <Button variant="bare" type="button" ref={isActive ? activeRef : undefined}
                    onClick={() => setCurrentPreset(name)} aria-pressed={isActive}
                    title={name} className="min-w-0 flex-1 truncate py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{name}</Button>
                </div>
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
