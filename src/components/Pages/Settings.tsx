import { useArtworkAppearanceStore } from "../../stores/artworkAppearanceStore"
import React, { useState, useEffect, useRef, useMemo } from "react"
import { useLocation } from "wouter"
import { open } from "@tauri-apps/plugin-shell"
import clsx from "clsx"
import { ImageCacheControls } from "../ImageCacheControls"
import { engine } from "../../audio/RustAudioEngine"
import { AudioCacheControls } from "../AudioCacheControls"
import { getVersion } from "@tauri-apps/api/app"
import { useAudioSettingsStore } from "../../stores/audioSettingsStore"
import { useUpdateStore } from "../../stores/updateStore"
import { useLastfmStore } from "../../metadata/lastfm/authStore"
import { useAccentStore, ACCENT_PRESETS } from "../../stores/accentStore"
import { getTheme, setTheme, subscribeTheme } from "../../stores/themeStore"
import { getFont, setFont, subscribeFont, FONT_PRESETS } from "../../stores/fontStore"
import type { FontPreset } from "../../stores/fontStore"
import { useCardSizeStore, CARD_SIZE_MIN, CARD_SIZE_MAX } from "../../stores/cardSizeStore"
import { useHighlightStore, HIGHLIGHT_DEFAULTS, type HighlightCategory } from "../../stores/highlightStore"
import { useNotificationStore } from "../../stores/notificationStore"
import { useNotificationCenterStore } from "../../stores/notificationCenterStore"
import { useDebugStore } from "../../stores/debugStore"
import { useUIStore } from "../../stores"
import { useEasterEggStore } from "../../stores/easterEggStore"
import { plexBackend } from "../../backends/plex/definition"
import { metadataBackends, getMetadataBackend } from "../../metadata"
import type { ProviderCapabilities } from "../../providers/types"
import type { MetadataCapabilities } from "../../metadata/types"
import { useMetadataSourceStore, type MetadataSource, SOURCE_LABELS, SOURCE_DESCRIPTIONS } from "../../stores/metadataSourceStore"
import { useCompactStore } from "../../stores/compactStore"
import { ColorPicker } from "../shared/ColorPicker"
import { useCustomColorStore, SEMANTIC_COLOR_LABELS, UI_COLOR_COUNT, type SemanticColor } from "../../stores/customColorStore"
import { useVisualizerStore } from "../../stores/visualizerStore"
import { useTranslation } from "react-i18next"
import { setLanguage } from "../../i18n"
import { useLibraryStore } from "../../stores/libraryStore"
import { clearMetadataCache, getMetadataCacheStats } from "../../stores/metadataCache"

// ---------------------------------------------------------------------------
// Section types & sidebar nav
// ---------------------------------------------------------------------------

type Section =
  | "plex" | "metadata" | `metadata/${string}`
  | "appearance" | "cache" | "general" | "about" | "eastereggs"

const NAV: { id: Section; label: string; icon: React.ReactNode }[] = [
  {
    id: "plex",
    label: "Plex",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20 13H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-6c0-.55-.45-1-1-1zM7 19c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM20 3H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1zM7 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" />
      </svg>
    ),
  },
  {
    id: "metadata",
    label: "Metadata",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z" />
      </svg>
    ),
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5S18.33 12 17.5 12z" />
      </svg>
    ),
  },
  {
    id: "cache" as Section,
    label: "Cache",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M21 10h-2V4h-2v6h-2V4h-2v6h-2V4H9v6H7V4H5v6H3v2h2v4H3v2h2v6h2v-6h2v6h2v-6h2v6h2v-6h2v6h2v-6h2v-2h-2v-4h2v-2zm-4 6H7v-4h10v4z" />
      </svg>
    ),
  },
  {
    id: "general",
    label: "General",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z" />
      </svg>
    ),
  },
  {
    id: "about",
    label: "About",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" />
      </svg>
    ),
  },
]

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={clsx(
        "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent",
        value ? "bg-accent" : "bg-white/20"
      )}
    >
      <span
        className={clsx(
          "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transform transition-transform duration-200 ease-in-out mt-0.5",
          value ? "translate-x-[22px]" : "translate-x-0.5"
        )}
      />
    </button>
  )
}

function PillGroup<T>({
  label,
  options,
  value,
  onChange,
  getLabel,
  isActive,
}: {
  label: string
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  getLabel: (v: T) => string
  isActive?: (opt: T, value: T) => boolean
}) {
  const check = isActive ?? ((a: T, b: T) => a === b)
  return (
    <div role="group" aria-label={label} className="flex gap-2 flex-wrap">
      {options.map((opt, i) => (
        <button
          key={i}
          type="button"
          aria-pressed={check(opt, value)}
          onClick={() => onChange(opt)}
          className={clsx(
            "rounded-full px-4 py-1.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            check(opt, value)
              ? "bg-accent text-black font-semibold"
              : "bg-white/10 text-white hover:bg-white/20"
          )}
        >
          {getLabel(opt)}
        </button>
      ))}
    </div>
  )
}

function SettingRow({
  label,
  description,
  inline,
  children,
}: {
  label: string
  description?: string
  inline?: boolean
  children: React.ReactNode
}) {
  if (inline) {
    return (
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white/80">{label}</p>
          {description && <p className="text-xs text-white/35 mt-0.5">{description}</p>}
        </div>
        <div className="flex-shrink-0">{children}</div>
      </div>
    )
  }
  return (
    <div>
      <p className="text-sm font-medium text-white/80 mb-1.5">{label}</p>
      {description && <p className="text-xs text-white/35 mb-2.5">{description}</p>}
      {children}
    </div>
  )
}

function SettingCard({
  title,
  description,
  disabled,
  badge,
  children,
}: {
  title: string
  description?: string
  disabled?: boolean
  badge?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={clsx(
        "rounded-xl border border-white/[0.06] bg-white/[0.03] p-5",
        disabled && "opacity-40 pointer-events-none select-none"
      )}
    >
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {badge && (
          <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-medium text-white/40">
            {badge}
          </span>
        )}
      </div>
      {description && <p className="text-xs text-white/35 -mt-2.5 mb-4">{description}</p>}
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Playback section
// ---------------------------------------------------------------------------

// Playback section removed — crossfade is always-on with smart defaults,
// normalization defaults to track mode +3dB, controllable via EQ panel.

// ---------------------------------------------------------------------------
// Appearance section (was Experience)
// ---------------------------------------------------------------------------

function AppearanceSection() {
  const { artworkColorsEnabled, setArtworkColorsEnabled, backgroundArtworkEnabled, setBackgroundArtworkEnabled, backgroundRotationEnabled, setBackgroundRotationEnabled, interfaceOpacity, setInterfaceOpacity } = useArtworkAppearanceStore()
  const { accent, setAccent } = useAccentStore()
  const [custom, setCustom] = useState(accent)
  const [theme, setThemeState] = useState(getTheme)
  const [font, setFontState] = useState<FontPreset>(getFont)
  const { cardSize, setCardSize } = useCardSizeStore()
  const { compact, setCompact } = useCompactStore()
  const [showPicker, setShowPicker] = useState(false)
  const { enabled: customColorsEnabled, overrides, setEnabled: setCustomColorsEnabled, setOverride, resetAll: resetCustomColors } = useCustomColorStore()
  const [showCustomColors, setShowCustomColors] = useState(false)

  useEffect(() => subscribeTheme(t => setThemeState(t)), [])
  useEffect(() => subscribeFont(f => setFontState(f)), [])

  function handleCustomChange(hex: string) {
    setCustom(hex)
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) setAccent(hex)
  }

  const isCustom = !ACCENT_PRESETS.some(p => p.hex.toLowerCase() === accent.toLowerCase())

  return (
    <div className="flex flex-col gap-5 max-w-2xl">

      {/* Theme */}
      <SettingCard title="Theme" description="Choose between dark, light, or follow your system preference.">
        <PillGroup
          label="Theme"
          options={["dark", "light", "system"] as const}
          value={theme}
          onChange={setTheme}
          getLabel={t => t.charAt(0).toUpperCase() + t.slice(1)}
        />
      </SettingCard>

      {/* Font */}
      <SettingCard title="Font" description="Pick a typeface for the entire interface.">
        <div className="space-y-3">
          {(["default", "sans-serif", "monospace"] as const).map(cat => {
            const presets = FONT_PRESETS.filter(p => p.category === cat)
            if (presets.length === 0) return null
            return (
              <div key={cat}>
                {cat !== "default" && (
                  <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/25 mb-1.5">
                    {cat === "sans-serif" ? "Sans-serif" : "Monospace"}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {presets.map(preset => (
                    <button
                      key={preset.name}
                      onClick={() => setFont(preset.name)}
                      style={{ fontFamily: preset.stack }}
                      className={clsx(
                        "rounded-full px-4 py-1.5 text-sm transition-colors",
                        font.name === preset.name
                          ? "bg-accent text-black font-semibold"
                          : "bg-white/10 text-white hover:bg-white/20"
                      )}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </SettingCard>

      {/* Accent Colour */}
      <SettingCard title="Accent Colour" description="Highlights, active states, and progress bars all follow this colour.">
        {/* Preset swatches */}
        <div className="flex flex-wrap gap-3 mb-6">
          {ACCENT_PRESETS.map(preset => {
            const active = preset.hex.toLowerCase() === accent.toLowerCase()
            return (
              <button
                key={preset.hex}
                onClick={() => { setAccent(preset.hex); setCustom(preset.hex) }}
                title={preset.name}
                className="group relative flex flex-col items-center gap-1.5"
              >
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded-full transition-all duration-150 ${
                    active
                      ? "ring-2 ring-offset-2 ring-offset-app-card scale-110"
                      : "hover:scale-105 ring-2 ring-transparent"
                  }`}
                  style={{
                    backgroundColor: preset.hex,
                    boxShadow: active ? `0 0 0 2px var(--bg-elevated), 0 0 0 4px ${preset.hex}` : undefined,
                  }}
                >
                  {active && (
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="black">
                      <path d="M13.78 3.22a.75.75 0 0 1 0 1.06l-8 8a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06L5.25 10.69l7.47-7.47a.75.75 0 0 1 1.06 0z"/>
                    </svg>
                  )}
                </span>
                <span className={`text-[10px] transition-colors ${active ? "text-white" : "text-white/40 group-hover:text-white/70"}`}>
                  {preset.name}
                </span>
              </button>
            )
          })}
        </div>

        {/* Custom hex input */}
        <div className="flex items-center gap-3">
          <div
            className="h-8 w-8 flex-shrink-0 rounded-full border border-white/20 transition-all"
            style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(custom) ? custom : accent }}
          />
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-white/30 select-none">#</span>
            <input
              type="text"
              value={custom.replace(/^#/, "")}
              onChange={e => handleCustomChange("#" + e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6))}
              placeholder="d946ef"
              maxLength={6}
              className={`w-28 rounded-lg bg-white/10 py-1.5 pl-7 pr-3 text-sm font-mono text-white placeholder-white/20 focus:outline-none focus:ring-1 transition-colors ${
                isCustom ? "ring-1 ring-accent" : "focus:ring-white/30"
              }`}
            />
          </div>
          <span className="text-xs text-white/30">
            {isCustom ? "Custom colour active" : "Enter a custom hex value"}
          </span>
        </div>

        {/* HSV Color Picker (collapsible) */}
        <div className="mt-4">
          <button
            onClick={() => setShowPicker(!showPicker)}
            className="flex items-center gap-2 text-xs text-white/40 hover:text-white/70 transition-colors"
          >
            <svg
              viewBox="0 0 16 16" width="10" height="10" fill="currentColor"
              className={`transition-transform ${showPicker ? "rotate-90" : ""}`}
            >
              <path d="M6 4l4 4-4 4z" />
            </svg>
            Advanced color picker
          </button>
          {showPicker && (
            <div className="mt-3">
              <ColorPicker value={accent} onChange={hex => { setAccent(hex); setCustom(hex) }} />
            </div>
          )}
        </div>

        {/* Live preview strip */}
        <div className="mt-6 rounded-xl bg-accent-tint-subtle p-4 flex items-center gap-4 border border-white/5">
          <span className="text-xs text-white/40 w-16 flex-shrink-0">Preview</span>
          <div className="flex items-center gap-3 flex-wrap">
            <button className="flex h-8 w-8 items-center justify-center rounded-full text-black text-sm font-bold shadow-md" style={{ backgroundColor: accent }}>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><polygon points="3,2 13,8 3,14" /></svg>
            </button>
            <div className="h-1.5 w-32 rounded-full overflow-hidden bg-white/10">
              <div className="h-full w-3/5 rounded-full" style={{ backgroundColor: accent }} />
            </div>
            <span className="text-sm font-semibold" style={{ color: accent }}>Now Playing</span>
            <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold text-black" style={{ backgroundColor: accent }}>Active</span>
          </div>
        </div>
      </SettingCard>

      {/* Card Size */}
      <SettingCard title="Card Size" description="Adjust the width of album and artist cards across all views.">
        <div className="flex items-center gap-4">
          <input
            type="range"
            min={CARD_SIZE_MIN}
            max={CARD_SIZE_MAX}
            step={10}
            value={cardSize}
            onChange={e => setCardSize(parseInt(e.target.value, 10))}
            className="flex-1 range-styled accent-[var(--accent)] cursor-pointer"
          />
          <span className="text-sm font-mono text-white/60 w-14 text-right">{cardSize}px</span>
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-xs text-white/25">Small</span>
          <span className="text-xs text-white/25">Large</span>
        </div>
      </SettingCard>

      {/* Compact Mode */}
      <SettingCard title="Compact Mode" description="Reduce spacing across the sidebar, top bar, and player for a denser layout.">
        <Toggle label="Compact Mode" value={compact} onChange={setCompact} />
      </SettingCard>

      <SettingCard title="Artwork colors" description="Use artwork colors for buttons across Hibiki. Your saved global accent and custom interface colors stay unchanged.">
        <Toggle label="Artwork colors" value={artworkColorsEnabled} onChange={setArtworkColorsEnabled} />
      </SettingCard>

      <SettingCard title="Background artwork" description="Let artwork show softly behind the app. Without artwork, or when reduced transparency is enabled, the interface stays opaque.">
        <Toggle label="Background artwork" value={backgroundArtworkEnabled} onChange={setBackgroundArtworkEnabled} />
        <div className="mt-4"><Toggle label="Rotate background every 45 seconds" value={backgroundRotationEnabled} onChange={setBackgroundRotationEnabled} /></div>
        <p className="mt-2 text-xs text-[color:var(--text-muted)]">Artist and album backgrounds stay with their page. Pause rotation or choose the next image from the toolbar.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label htmlFor="interface-opacity" className="text-sm text-[color:var(--text-secondary)]">Interface opacity</label>
          <input id="interface-opacity" type="range" min={0.45} max={1} step={0.01} value={interfaceOpacity} disabled={!backgroundArtworkEnabled} onChange={event => setInterfaceOpacity(Number(event.target.value))} className="range-styled min-w-0 flex-1 accent-[var(--accent)] disabled:opacity-40" />
          <output htmlFor="interface-opacity" className="text-xs tabular-nums text-[color:var(--text-secondary)]">{Math.round(interfaceOpacity * 100)}%</output>
        </div>
        <p className="mt-2 text-xs text-[color:var(--text-muted)]">More transparent ← → More opaque. A readability floor keeps text clear.</p>
      </SettingCard>

      {/* Highlight Intensity */}
      <HighlightCard />

      {/* Visualizer Colors */}
      <VisualizerColorsCard />

      {/* Custom Colors */}
      <SettingCard title="Custom Colors" description="Override individual semantic colors for a fully custom look.">
        <div className="flex items-center justify-between mb-3">
          <Toggle label="Custom Colors" value={customColorsEnabled} onChange={setCustomColorsEnabled} />
          {customColorsEnabled && Object.keys(overrides).length > 0 && (
            <button
              onClick={resetCustomColors}
              className="text-xs text-white/40 hover:text-white/70 transition-colors"
            >
              Reset all
            </button>
          )}
        </div>
        <button
          onClick={() => setShowCustomColors(!showCustomColors)}
          className="flex items-center gap-2 text-xs text-white/40 hover:text-white/70 transition-colors"
        >
          <svg
            viewBox="0 0 16 16" width="10" height="10" fill="currentColor"
            className={`transition-transform ${showCustomColors ? "rotate-90" : ""}`}
          >
            <path d="M6 4l4 4-4 4z" />
          </svg>
          {showCustomColors ? "Hide color overrides" : "Show color overrides"}
        </button>
        {showCustomColors && (
          <div className="mt-3 grid gap-2">
            {(Object.keys(SEMANTIC_COLOR_LABELS) as SemanticColor[]).map((key, idx) => (
              <React.Fragment key={key}>
                {idx === UI_COLOR_COUNT && (
                  <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/25 mt-2 mb-0.5">System</p>
                )}
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={overrides[key] || getComputedStyle(document.documentElement).getPropertyValue(`--${key}`).trim() || "#000000"}
                  onChange={e => setOverride(key, e.target.value)}
                  disabled={!customColorsEnabled}
                  className="h-7 w-7 cursor-pointer rounded border border-white/10 bg-transparent disabled:opacity-30"
                />
                <span className="text-sm text-white/60 flex-1">{SEMANTIC_COLOR_LABELS[key]}</span>
                {overrides[key] && (
                  <button
                    onClick={() => setOverride(key, null)}
                    className="text-[10px] text-white/30 hover:text-white/60"
                  >
                    Reset
                  </button>
                )}
              </div>
              </React.Fragment>
            ))}
          </div>
        )}
      </SettingCard>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Highlight Intensity (card variant)
// ---------------------------------------------------------------------------

const HL_CATEGORIES: { key: HighlightCategory; label: string; desc: string }[] = [
  { key: "card",  label: "Card hover",  desc: "Album/artist cards" },
  { key: "row",   label: "Track row",   desc: "Track list rows" },
  { key: "menu",  label: "Menu / dropdown", desc: "Context menu, dropdowns" },
  { key: "queue", label: "Queue",       desc: "Queue panel items" },
]

function HighlightCard() {
  const { intensity, setIntensity, setCategory, reset, ...cats } = useHighlightStore()
  const [showAdvanced, setShowAdvanced] = useState(false)

  const pct = Math.round(intensity * 100)
  const isDefault = intensity === 1
    && cats.card === HIGHLIGHT_DEFAULTS.card
    && cats.row === HIGHLIGHT_DEFAULTS.row
    && cats.menu === HIGHLIGHT_DEFAULTS.menu
    && cats.queue === HIGHLIGHT_DEFAULTS.queue

  return (
    <SettingCard title="Highlight Intensity" description="Scale how visible the accent-coloured highlights are across the entire UI.">
      {/* Global intensity slider */}
      <div className="flex items-center gap-4">
        <input
          type="range"
          min={25}
          max={200}
          step={5}
          value={pct}
          onChange={e => setIntensity(parseInt(e.target.value, 10) / 100)}
          className="flex-1 range-styled accent-[var(--accent)] cursor-pointer"
        />
        <span className="text-sm font-mono text-white/60 w-14 text-right">{pct}%</span>
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-xs text-white/25">Subtle</span>
        <span className="text-xs text-white/25">Vivid</span>
      </div>

      {/* Live preview */}
      <div className="mt-5 rounded-xl bg-white/5 p-4 border border-white/5">
        <span className="text-xs text-white/40 block mb-3">Preview</span>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3 px-3 py-2 rounded-md bg-hl-card">
            <div className="h-8 w-8 rounded bg-white/10 flex-shrink-0" />
            <div>
              <div className="text-xs font-medium text-white">Card hover</div>
              <div className="text-[10px] text-white/40">Album or artist card</div>
            </div>
          </div>
          <div className="flex items-center gap-3 px-3 py-1.5 rounded bg-hl-row">
            <div className="text-xs text-white/50 w-4 text-center">1</div>
            <div className="h-7 w-7 rounded-sm bg-white/10 flex-shrink-0" />
            <div className="text-xs font-medium text-white">Track row highlight</div>
          </div>
          <div className="flex items-center gap-2.5 px-3 py-1.5 rounded bg-hl-menu">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" className="text-white/60"><polygon points="3,2 13,8 3,14" /></svg>
            <span className="text-xs text-white/85">Menu item</span>
          </div>
          <div className="flex items-center gap-3 px-3 py-2 rounded-md bg-hl-queue">
            <div className="h-7 w-7 rounded-sm bg-white/10 flex-shrink-0" />
            <div className="text-xs font-medium text-white">Queue item</div>
          </div>
        </div>
      </div>

      {/* Advanced per-category sliders */}
      <button
        onClick={() => setShowAdvanced(o => !o)}
        className="mt-4 flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors"
      >
        <svg
          viewBox="0 0 16 16" width="10" height="10" fill="currentColor"
          className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}
        >
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z"/>
        </svg>
        Per-element fine tuning
      </button>

      {showAdvanced && (
        <div className="mt-3 flex flex-col gap-4 pl-2 border-l border-white/10">
          {HL_CATEGORIES.map(({ key, label, desc }) => {
            const val = cats[key]
            const defVal = HIGHLIGHT_DEFAULTS[key]
            return (
              <div key={key}>
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-xs font-medium text-white/70">{label}</span>
                  <span className="text-[10px] text-white/30">{desc}</span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={40}
                    step={1}
                    value={Math.round(val * 100)}
                    onChange={e => setCategory(key, parseInt(e.target.value, 10) / 100)}
                    className="flex-1 range-styled accent-[var(--accent)] cursor-pointer"
                  />
                  <span className="text-xs font-mono text-white/50 w-10 text-right">{Math.round(val * 100)}%</span>
                  {val !== defVal && (
                    <button
                      onClick={() => setCategory(key, defVal)}
                      className="text-[10px] text-white/30 hover:text-white/60 transition-colors"
                      title="Reset to default"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Reset all button */}
      {!isDefault && (
        <button
          onClick={reset}
          className="mt-4 text-xs text-white/40 hover:text-white/70 transition-colors underline underline-offset-2"
        >
          Reset all to defaults
        </button>
      )}
    </SettingCard>
  )
}

// ---------------------------------------------------------------------------
// Visualizer Colors card
// ---------------------------------------------------------------------------

const VIZ_COLOR_DEFAULTS = { low: "#22c55e", mid: "#eab308", high: "#ef4444" }

function VisualizerColorsCard() {
  const vizColorLow = useVisualizerStore(s => s.vizColorLow)
  const vizColorMid = useVisualizerStore(s => s.vizColorMid)
  const vizColorHigh = useVisualizerStore(s => s.vizColorHigh)
  const { setVizColorLow, setVizColorMid, setVizColorHigh } = useVisualizerStore.getState()

  const isDefault = vizColorLow === VIZ_COLOR_DEFAULTS.low
    && vizColorMid === VIZ_COLOR_DEFAULTS.mid
    && vizColorHigh === VIZ_COLOR_DEFAULTS.high

  return (
    <SettingCard title="Visualizer Colors" description="Customize the frequency band colors used in spectrum, VU meter, and oscilloscope visualizers.">
      <div className="flex items-center gap-6">
        {([
          { label: "Bass", value: vizColorLow, set: setVizColorLow },
          { label: "Mid", value: vizColorMid, set: setVizColorMid },
          { label: "Treble", value: vizColorHigh, set: setVizColorHigh },
        ] as const).map(({ label, value, set: setter }) => (
          <div key={label} className="flex items-center gap-2">
            <input
              type="color"
              value={value}
              onChange={e => setter(e.target.value)}
              className="h-8 w-8 cursor-pointer rounded-full border border-white/10 bg-transparent"
            />
            <span className="text-sm text-white/60">{label}</span>
          </div>
        ))}
        {!isDefault && (
          <button
            onClick={() => {
              setVizColorLow(VIZ_COLOR_DEFAULTS.low)
              setVizColorMid(VIZ_COLOR_DEFAULTS.mid)
              setVizColorHigh(VIZ_COLOR_DEFAULTS.high)
            }}
            className="text-xs text-white/40 hover:text-white/70 transition-colors ml-auto"
          >
            Reset
          </button>
        )}
      </div>
      {/* Preview gradient */}
      <div className="mt-3 h-3 rounded-full overflow-hidden" style={{
        background: `linear-gradient(to right, ${vizColorLow}, ${vizColorMid}, ${vizColorHigh})`,
      }} />
    </SettingCard>
  )
}

// ---------------------------------------------------------------------------
// Cache section
// ---------------------------------------------------------------------------

function CacheSection() {
  const [libClearing, setLibClearing] = useState(false)
  const [metaClearing, setMetaClearing] = useState(false)
  const [, forceUpdate] = useState(0)

  const cacheMaxBytes = useAudioSettingsStore(s => s.cacheMaxBytes)
  const setCacheMaxBytes = useAudioSettingsStore(s => s.setCacheMaxBytes)

  const libStore = useLibraryStore.getState()
  const playlistCount = libStore.playlists.length
  const hubCount = libStore.hubs.length
  const recentlyAddedCount = libStore.recentlyAdded.length
  const playlistCacheCount = Object.keys(libStore.playlistItemsCache).length
  const mixCacheCount = Object.keys(libStore.mixTracksCache).length

  const metaStats = getMetadataCacheStats()

  function handleClearLibrary() {
    setLibClearing(true)
    useLibraryStore.getState().invalidateCache()
    setTimeout(() => { setLibClearing(false); forceUpdate(n => n + 1) }, 300)
  }

  function handleClearMetadata() {
    setMetaClearing(true)
    clearMetadataCache()
    setTimeout(() => { setMetaClearing(false); forceUpdate(n => n + 1) }, 300)
  }

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      {/* Audio Cache */}
      <SettingCard title="Audio Cache" description="Cached audio files from Plex for instant replay. Tracks are cached as they play.">
        <AudioCacheControls backend={engine} maximum={cacheMaxBytes} onMaximumChange={setCacheMaxBytes} />
      </SettingCard>

      {/* Image Cache */}
      <SettingCard title="Image Cache" description="Artwork fetched from Plex and external metadata sources.">
        <ImageCacheControls />
      </SettingCard>

      {/* Library Cache */}
      <SettingCard title="Library Cache" description="Cached playlists, hubs, and recently added items. Clearing forces a fresh fetch from your Plex server.">
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white">Library Data</p>
            <p className="text-xs text-white/40 mt-0.5">
              {playlistCount} playlists · {hubCount} hubs · {recentlyAddedCount} recently added · {playlistCacheCount} playlist caches · {mixCacheCount} mix caches
            </p>
          </div>
          <button
            onClick={handleClearLibrary}
            disabled={libClearing}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:border-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            {libClearing ? "Clearing..." : "Clear"}
          </button>
        </div>
      </SettingCard>

      {/* Metadata Cache */}
      <SettingCard title="Page Metadata Cache" description="Cached artist and album page data for instant navigation.">
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white">Metadata Entries</p>
            <p className="text-xs text-white/40 mt-0.5">
              {metaStats.artistCount} artists · {metaStats.albumCount} albums
            </p>
          </div>
          <button
            onClick={handleClearMetadata}
            disabled={metaClearing || (metaStats.artistCount === 0 && metaStats.albumCount === 0)}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:border-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            {metaClearing ? "Clearing..." : "Clear"}
          </button>
        </div>
      </SettingCard>
    </div>
  )
}

// ---------------------------------------------------------------------------
// General section (Notifications + Debug + Coming Soon placeholders)
// ---------------------------------------------------------------------------

const LANGUAGES = [
  { code: "en", label: "English" },
] as const

function GeneralSection() {
  const { notificationsEnabled, setNotificationsEnabled, warningNotificationsEnabled, setWarningNotificationsEnabled } = useNotificationStore()
  const [requestingNotificationPermission, setRequestingNotificationPermission] = useState(false)
  const notificationPermissionRequest = useRef(false)
  const { debugEnabled, setDebugEnabled } = useDebugStore()
  const deduplicateAlbums = useUIStore(s => s.deduplicateAlbums)
  const setDeduplicateAlbums = useUIStore(s => s.setDeduplicateAlbums)
  const { i18n: i18nInstance } = useTranslation()
  const currentLang = i18nInstance.language

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <SettingCard title="Language" description="Choose the display language for the interface.">
        <div className="flex flex-wrap gap-2">
          {LANGUAGES.map(lang => (
            <button
              key={lang.code}
              onClick={() => setLanguage(lang.code)}
              className={clsx(
                "rounded-full px-4 py-1.5 text-sm transition-colors",
                currentLang === lang.code
                  ? "bg-accent text-black font-semibold"
                  : "bg-white/10 text-white hover:bg-white/20"
              )}
            >
              {lang.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-white/30">More languages coming soon. Contribute translations on GitHub.</p>
      </SettingCard>

      <SettingCard title="Preferences">
        <div className="flex flex-col gap-5">
          <SettingRow
            label="Track Notifications"
            description="Show an OS notification when a new track starts playing."
            inline
          >
            <Toggle label="Track Notifications" value={notificationsEnabled} onChange={setNotificationsEnabled} />
          </SettingRow>

          <div className="border-t border-white/[0.06]" />

          <SettingRow
            label="System alerts"
            description="Show warnings and errors in system notifications while Hibiki is in the background. In-app notifications are always available."
            inline
          >
            <button
              role="switch"
              aria-label="System alerts"
              aria-checked={warningNotificationsEnabled}
              disabled={requestingNotificationPermission}
              className={clsx("relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-50", warningNotificationsEnabled ? "bg-accent" : "bg-white/20")}
              onClick={() => {
                if (notificationPermissionRequest.current) return
                const enabling = !warningNotificationsEnabled
                notificationPermissionRequest.current = true
                setRequestingNotificationPermission(true)
                void setWarningNotificationsEnabled(enabling).then(accepted => {
                  if (enabling && !accepted) useNotificationCenterStore.getState().notify({ id: "system.notifications.permission", title: "System notifications are unavailable", message: "Allow notifications for Hibiki in your system settings, then try again. In-app notifications remain available.", severity: "info" })
                }).finally(() => { notificationPermissionRequest.current = false; setRequestingNotificationPermission(false) })
              }}
            >
              <span className={clsx("pointer-events-none mt-0.5 inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform", warningNotificationsEnabled ? "translate-x-[22px]" : "translate-x-0.5")} />
            </button>
          </SettingRow>

          <div className="border-t border-white/[0.06]" />

          <SettingRow
            label="Album Deduplication"
            description="Merge duplicate albums on artist pages and pick the best quality version for playback."
            inline
          >
            <Toggle label="Album Deduplication" value={deduplicateAlbums} onChange={setDeduplicateAlbums} />
          </SettingRow>

          <div className="border-t border-white/[0.06]" />

          <SettingRow
            label="Debug Mode"
            description="Shows raw Plex IDs, file paths, and stream data in track info and right-click menus."
            inline
          >
            <Toggle label="Debug Mode" value={debugEnabled} onChange={setDebugEnabled} />
          </SettingRow>
        </div>
      </SettingCard>

      <SettingCard title="Downloads" disabled badge="Coming soon">
        <p className="text-sm text-white/40">Offline caching and download quality settings will appear here.</p>
      </SettingCard>

      <SettingCard title="AI" disabled badge="Coming soon">
        <p className="text-sm text-white/40">Sonic recommendations, radio tuning and smart mix settings will appear here.</p>
      </SettingCard>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Backends section
// ---------------------------------------------------------------------------

const CAPABILITY_LABELS: Record<keyof ProviderCapabilities, string> = {
  search: "Search",
  playlists: "Playlists",
  playlistEdit: "Edit Playlists",
  ratings: "Ratings",
  radio: "Radio",
  sonicSimilarity: "Sonic Similarity",
  djModes: "DJ Modes",
  playQueues: "Play Queues",
  lyrics: "Lyrics",
  streamLevels: "Waveforms",
  hubs: "Home Hubs",
  stations: "Stations",
  tags: "Tag Browsing",
  scrobble: "Scrobble",
  mixTracks: "Mix Tracks",
  browseArtists: "Artists",
  browseAlbums: "Albums",
  browseTracks: "Tracks",
  syncArtists: "Sync Artists",
  syncAlbums: "Sync Albums",
  syncTracks: "Sync Tracks",
}

const METADATA_CAPABILITY_LABELS: Record<keyof MetadataCapabilities, string> = {
  artistBio: "Artist Bio",
  artistImages: "Artist Images",
  albumCovers: "Album Covers",
  genres: "Genres",
  tags: "Tags",
  fanCounts: "Fan Counts",
  listenerCounts: "Listener Counts",
  similarArtists: "Similar Artists",
  trackInfo: "Track Info",
  scrobble: "Scrobble",
  lyrics: "Lyrics",
}

const SOURCE_ICONS: Record<MetadataSource, React.ReactNode> = {
  plex: (
    <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor" className="text-yellow-400">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z" />
    </svg>
  ),
  deezer: (
    <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor" className="text-[#EF5466]">
      <rect x="2" y="14" width="3" height="6" rx="1" />
      <rect x="6.5" y="11" width="3" height="9" rx="1" />
      <rect x="11" y="8" width="3" height="12" rx="1" />
      <rect x="15.5" y="5" width="3" height="15" rx="1" />
      <rect x="20" y="2" width="2" height="18" rx="1" />
    </svg>
  ),
  lastfm: (
    <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor" className="text-red-500">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
    </svg>
  ),
  apple: (
    <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor" className="text-pink-400">
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  ),
  musicbrainz: (
    <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor" className="text-[#BA478F]">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15.5v-3l-3 3v-7l3 3v-3l3 3v-3l3 3v-7l-3 3v-3l-3 3v-3l-3 3V5.5l9 6.5-9 6.5z" />
    </svg>
  ),
}

function CapabilityGrid({ caps, labels }: { caps: { [k: string]: boolean }; labels: { [k: string]: string } }) {
  const entries = Object.entries(labels)
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {entries.map(([key, label]) => {
        const supported = caps[key as keyof typeof caps]
        return (
          <div key={key} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
            {supported ? (
              <svg height="14" width="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-accent flex-shrink-0">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : (
              <span className="text-white/20 flex-shrink-0 text-xs font-bold w-3.5 text-center">-</span>
            )}
            <span className={`text-xs ${supported ? "text-white/70" : "text-white/25"}`}>{label}</span>
          </div>
        )
      })}
    </div>
  )
}

function SupportedFeatures({ children }: { children: React.ReactNode }) {
  return <details className="rounded-xl border border-[var(--border)] bg-app-card">
    <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm font-medium text-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Supported features</summary>
    <div className="border-t border-[var(--border)] p-4">{children}</div>
  </details>
}

function PlexSection() {
  return (
    <div className="max-w-2xl space-y-6">
      {/* Plex connection settings */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/25 mb-4">Settings</h3>
        <plexBackend.SettingsComponent />
      </div>

      {/* Image Cache */}
      <SettingCard title="Image Cache" description="Artwork fetched from Plex and external metadata sources is saved to disk.">
        <ImageCacheControls />
      </SettingCard>
      <SupportedFeatures>
        <CapabilityGrid caps={plexBackend.capabilities as unknown as { [k: string]: boolean }} labels={CAPABILITY_LABELS} />
      </SupportedFeatures>
    </div>
  )
}

function MetadataListView({ setSection }: { setSection: (s: Section) => void }) {
  const { hasApiKey: lastfmHasApiKey } = useLastfmStore()
  const { priority, setPriority } = useMetadataSourceStore()

  // Pointer-based drag for source priority
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const sortListRef = useRef<HTMLDivElement>(null)

  function getHoveredIndex(clientY: number): number | null {
    if (!sortListRef.current) return null
    const children = Array.from(sortListRef.current.children) as HTMLElement[]
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect()
      if (clientY >= rect.top && clientY <= rect.bottom) return i
    }
    return null
  }

  function onHandlePointerDown(e: React.PointerEvent, idx: number) {
    e.preventDefault()
    sortListRef.current?.setPointerCapture(e.pointerId)
    setDraggingIdx(idx)
    setHoverIdx(idx)
  }

  function onListPointerMove(e: React.PointerEvent) {
    if (draggingIdx === null) return
    const idx = getHoveredIndex(e.clientY)
    if (idx !== null) setHoverIdx(idx)
  }

  function onListPointerUp(e: React.PointerEvent) {
    if (draggingIdx === null) return
    const toIdx = getHoveredIndex(e.clientY) ?? draggingIdx
    if (toIdx !== draggingIdx) {
      const next = [...priority]
      const [item] = next.splice(draggingIdx, 1)
      next.splice(toIdx, 0, item)
      setPriority(next)
    }
    setDraggingIdx(null)
    setHoverIdx(null)
  }

  return (
    <div className="max-w-2xl space-y-6">

      {/* Metadata Source Priority */}
      <SettingCard title="Metadata Source Priority" description="Drag to reorder. Higher sources take precedence for bios, images, genres, and tags. Artist, album, and track names always come from Plex.">
        <div
          ref={sortListRef}
          className="flex flex-col gap-2 touch-none"
          onPointerMove={onListPointerMove}
          onPointerUp={onListPointerUp}
          onPointerCancel={onListPointerUp}
        >
          {priority.map((source, idx) => (
            <div
              key={source}
              className={clsx(
                "flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors select-none",
                draggingIdx === idx
                  ? "border-accent/60 bg-accent/15 opacity-70"
                  : hoverIdx === idx && draggingIdx !== null
                    ? "border-accent/50 bg-accent/10"
                    : "border-white/10 bg-white/3"
              )}
            >
              <div
                className="cursor-grab active:cursor-grabbing p-0.5 -ml-0.5 flex-shrink-0"
                onPointerDown={e => onHandlePointerDown(e, idx)}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" className="text-white/30 pointer-events-none">
                  <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
                </svg>
              </div>
              <span className="flex-shrink-0">{SOURCE_ICONS[source]}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white">{SOURCE_LABELS[source]}</p>
                <p className="text-xs text-white/40 truncate">{SOURCE_DESCRIPTIONS[source]}</p>
              </div>
              <span className="text-xs font-mono text-white/20 tabular-nums">#{idx + 1}</span>
              {source === "lastfm" && !lastfmHasApiKey && (
                <span className="rounded-full bg-white/8 px-2 py-0.5 text-xs text-white/35 flex-shrink-0">No API key</span>
              )}
            </div>
          ))}
        </div>
      </SettingCard>

      {/* Metadata Backends */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/25 mb-4">Metadata Sources</h3>
        <div className="space-y-3">
          {metadataBackends.map(mb => {
            const enabled = mb.useIsEnabled()
            const Icon = mb.icon
            return (
              <button
                key={mb.id}
                onClick={() => setSection(`metadata/${mb.id}` as Section)}
                className="w-full rounded-xl bg-white/5 px-5 py-4 text-left hover:bg-white/8 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <span className="text-white/60"><Icon size={20} /></span>
                  <span className="text-sm font-semibold text-white">{mb.name}</span>
                  <span className="ml-auto flex items-center gap-1.5 text-xs">
                    <span className={`h-2 w-2 rounded-full ${enabled ? "bg-accent" : "bg-white/20"}`} />
                    <span className={enabled ? "text-accent" : "text-white/30"}>
                      {enabled ? (mb.id === "lastfm" ? "Enabled" : "Always on") : "Disabled"}
                    </span>
                  </span>
                  <svg height="14" width="14" viewBox="0 0 24 24" fill="currentColor" className="text-white/20 group-hover:text-white/40 transition-colors">
                    <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
                  </svg>
                </div>
                <p className="mt-1.5 text-xs text-white/35">{mb.description}</p>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function MetadataSubPage({ backendId, goBack }: { backendId: string; goBack: () => void }) {
  const metaBackend = getMetadataBackend(backendId)

  if (!metaBackend) {
    return (
      <div className="max-w-2xl">
        <button onClick={goBack} className="mb-6 flex items-center gap-1.5 text-sm text-white/50 hover:text-white transition-colors">
          <svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></svg>
          Back to Metadata
        </button>
        <p className="text-sm text-white/50">Metadata source not found.</p>
      </div>
    )
  }

  const Icon = metaBackend.icon
  const Settings = metaBackend.SettingsComponent

  return (
    <div className="max-w-2xl space-y-8">
      {/* Back button + header */}
      <div>
        <button onClick={goBack} className="mb-4 flex items-center gap-1.5 text-sm text-white/50 hover:text-white transition-colors">
          <svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></svg>
          Back to Metadata
        </button>
        <div className="flex items-center gap-3">
          <span className="text-white/60"><Icon size={24} /></span>
          <h2 className="text-2xl font-bold">{metaBackend.name}</h2>
        </div>
      </div>

      {/* Settings */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/25 mb-4">Settings</h3>
        <Settings />
      </div>
      <SupportedFeatures>
        <CapabilityGrid caps={metaBackend.capabilities as unknown as { [k: string]: boolean }} labels={METADATA_CAPABILITY_LABELS} />
      </SupportedFeatures>
    </div>
  )
}

// ---------------------------------------------------------------------------
// About section
// ---------------------------------------------------------------------------

function CreditLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button onClick={() => void open(href)} className="text-accent hover:underline text-left">
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Floating orbs background animation for the About section
// ---------------------------------------------------------------------------

function FloatingOrbs() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let raf: number
    let w = 0
    let h = 0

    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#d946ef"

    // Parse accent hex to r,g,b
    const hexToRgb = (hex: string) => {
      const c = hex.replace("#", "")
      return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)] as const
    }
    const [ar, ag, ab] = hexToRgb(accent)

    interface Orb { x: number; y: number; r: number; vx: number; vy: number; hue: number; alpha: number; pulse: number; pulseSpeed: number }

    const orbs: Orb[] = []
    const ORB_COUNT = 7

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const init = () => {
      resize()
      orbs.length = 0
      for (let i = 0; i < ORB_COUNT; i++) {
        orbs.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: 60 + Math.random() * 120,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          hue: Math.random() * 60 - 30, // offset from accent hue
          alpha: 0.08 + Math.random() * 0.08,
          pulse: Math.random() * Math.PI * 2,
          pulseSpeed: 0.003 + Math.random() * 0.005,
        })
      }
    }

    const draw = () => {
      ctx.clearRect(0, 0, w, h)
      for (const orb of orbs) {
        orb.x += orb.vx
        orb.y += orb.vy
        orb.pulse += orb.pulseSpeed

        // Bounce off edges softly
        if (orb.x < -orb.r) orb.x = w + orb.r
        if (orb.x > w + orb.r) orb.x = -orb.r
        if (orb.y < -orb.r) orb.y = h + orb.r
        if (orb.y > h + orb.r) orb.y = -orb.r

        const pulseFactor = 1 + Math.sin(orb.pulse) * 0.25
        const currentR = orb.r * pulseFactor
        const currentAlpha = orb.alpha * (0.7 + Math.sin(orb.pulse * 0.7) * 0.3)

        // Shift accent colour slightly per orb
        const shift = orb.hue / 60
        const r = Math.min(255, Math.max(0, ar + shift * 40))
        const g = Math.min(255, Math.max(0, ag + shift * 20))
        const b = Math.min(255, Math.max(0, ab - shift * 20))

        const grad = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, currentR)
        grad.addColorStop(0, `rgba(${r},${g},${b},${currentAlpha})`)
        grad.addColorStop(0.6, `rgba(${r},${g},${b},${currentAlpha * 0.4})`)
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`)

        ctx.beginPath()
        ctx.arc(orb.x, orb.y, currentR, 0, Math.PI * 2)
        ctx.fillStyle = grad
        ctx.fill()
      }
      raf = requestAnimationFrame(draw)
    }

    init()
    draw()

    window.addEventListener("resize", resize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("resize", resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ filter: "blur(50px)" }}
    />
  )
}

// ---------------------------------------------------------------------------
// Animated tech stack badge for the About hero
// ---------------------------------------------------------------------------

const TECH_STACK: { label: string; href: string; category: "core" | "audio" | "frontend" | "backend" }[] = [
  { label: "Tauri", href: "https://v2.tauri.app", category: "core" },
  { label: "React", href: "https://react.dev", category: "core" },
  { label: "TypeScript", href: "https://www.typescriptlang.org", category: "core" },
  { label: "Rust", href: "https://www.rust-lang.org", category: "core" },
  { label: "Vite", href: "https://vitejs.dev", category: "core" },
  { label: "Web Audio API", href: "https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API", category: "audio" },
  { label: "Butterchurn", href: "https://github.com/jprjr/butterchurn", category: "audio" },
  { label: "Tailwind CSS", href: "https://tailwindcss.com", category: "frontend" },
  { label: "Zustand", href: "https://zustand.docs.pmnd.rs", category: "frontend" },
  { label: "Wouter", href: "https://github.com/molefrog/wouter", category: "frontend" },
  { label: "dnd kit", href: "https://dndkit.com", category: "frontend" },
  { label: "Tokio", href: "https://tokio.rs", category: "backend" },
  { label: "reqwest", href: "https://github.com/seanmonstar/reqwest", category: "backend" },
  { label: "Serde", href: "https://serde.rs", category: "backend" },
  { label: "Souvlaki", href: "https://github.com/Sinono3/souvlaki", category: "backend" },
]

const CATEGORY_LABELS: Record<string, string> = {
  core: "Core",
  audio: "Audio",
  frontend: "Frontend",
  backend: "Backend",
}

function TechBadge({ item }: { item: typeof TECH_STACK[number] }) {
  return (
    <button
      onClick={() => void open(item.href)}
      className="group relative rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-white/60 transition-all duration-200 hover:border-accent/30 hover:bg-accent/10 hover:text-accent hover:scale-105"
    >
      {item.label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// About section
// ---------------------------------------------------------------------------

function AboutSection() {
  const [version, setVersion] = useState("")
  const { update, checking, error, lastChecked, checkForUpdate, setShowDialog } = useUpdateStore()

  useEffect(() => {
    void getVersion().then(setVersion)
  }, [])

  const categories = useMemo(() => {
    const cats = [...new Set(TECH_STACK.map((t) => t.category))]
    return cats.map((c) => ({ key: c, label: CATEGORY_LABELS[c] || c, items: TECH_STACK.filter((t) => t.category === c) }))
  }, [])

  return (
    <div className="max-w-3xl space-y-8">
      {/* ── Hero card with animated background ── */}
      <div className="relative overflow-hidden rounded-2xl border border-white/[0.08]">
        <FloatingOrbs />

        {/* Glassmorphism overlay */}
        <div className="relative z-10 flex flex-col items-center py-14 px-8 text-center">
          {/* App icon */}
          <div className="mb-5 rounded-[22px] bg-white/[0.06] p-1 shadow-2xl ring-1 ring-white/10 backdrop-blur-sm">
            <svg width="72" height="72" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="200" height="200" rx="45" fill="#111"/>
              <path d="M 78,72 C 78,65 84,62 90,66 L 128,90 C 135,94 135,106 128,110 L 90,134 C 84,138 78,135 78,128 Z" fill="#e8e8e8"/>
              <path d="M 65,55 C 65,46 73,42 80,47 L 141,83 C 149,88 149,112 141,117 L 80,153 C 73,158 65,154 65,145 Z" fill="none" stroke="#e8e8e8" strokeWidth="2" strokeLinejoin="round" opacity="0.42"/>
              <path d="M 52,38 C 52,27 62,22 70,28 L 154,76 C 163,82 163,118 154,124 L 70,172 C 62,178 52,173 52,162 Z" fill="none" stroke="#e8e8e8" strokeWidth="1.5" strokeLinejoin="round" opacity="0.17"/>
            </svg>
          </div>

          {/* App name */}
          <h1 className="text-3xl font-bold tracking-tight text-white">Hibiki</h1>
          <p className="mt-1 text-sm text-white/40">A Plex music client</p>

          {/* Version pill */}
          <div className="mt-4 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.08] px-3 py-1 text-xs font-medium text-white/60 ring-1 ring-white/[0.06]">
              <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
              v{version || "\u2026"}
            </span>
          </div>

          {/* Quick links */}
          <div className="mt-6 flex gap-3">
            <button
              onClick={() => void open("https://github.com/karbowiak/hibiki")}
              className="flex items-center gap-2 rounded-full bg-white/[0.08] px-4 py-2 text-xs font-medium text-white/70 ring-1 ring-white/[0.06] transition-all hover:bg-white/[0.14] hover:text-white"
            >
              <svg height="14" width="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
              GitHub
            </button>
            <button
              onClick={() => void open("https://github.com/karbowiak/hibiki/releases")}
              className="flex items-center gap-2 rounded-full bg-white/[0.08] px-4 py-2 text-xs font-medium text-white/70 ring-1 ring-white/[0.06] transition-all hover:bg-white/[0.14] hover:text-white"
            >
              <svg height="14" width="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Releases
            </button>
          </div>
        </div>
      </div>

      {/* ── Updates ── */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.025] p-5">
        <div className="flex items-center gap-3 mb-4">
          <svg height="16" width="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/40"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          <h3 className="text-sm font-semibold text-white">Updates</h3>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => void checkForUpdate()}
              disabled={checking}
              className="rounded-full px-4 py-1.5 text-sm bg-white/[0.08] text-white/80 ring-1 ring-white/[0.06] hover:bg-white/[0.14] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {checking ? "Checking\u2026" : "Check for Updates"}
            </button>
            {checking && (
              <svg className="animate-spin text-accent" height="16" width="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" />
              </svg>
            )}
          </div>

          {!checking && update && (
            <div className="rounded-xl bg-accent/10 border border-accent/20 px-4 py-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-accent">Version {update.version} available</p>
                {update.body && <p className="text-xs text-white/40 mt-0.5 line-clamp-1">{update.body}</p>}
              </div>
              <button
                onClick={() => setShowDialog(true)}
                className="rounded-full px-4 py-1.5 text-sm bg-accent text-black font-semibold flex-shrink-0"
              >
                Install
              </button>
            </div>
          )}

          {!checking && !update && !error && lastChecked && (
            <p className="text-xs text-white/40">You're on the latest version.</p>
          )}

          {!checking && error && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">{error}</div>
          )}
        </div>
      </div>

      {/* ── Built With ── */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.025] p-6">
        <h3 className="text-sm font-semibold text-white mb-1">Built With</h3>
        <p className="text-xs text-white/35 mb-5">The open-source projects that power Hibiki.</p>

        <div className="space-y-5">
          {categories.map((cat) => (
            <div key={cat.key}>
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/25 mb-2.5">{cat.label}</p>
              <div className="flex flex-wrap gap-2">
                {cat.items.map((item) => (
                  <TechBadge key={item.label} item={item} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Special Thanks ── */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.025] p-6">
        <h3 className="text-sm font-semibold text-white mb-4">Special Thanks</h3>
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-xl bg-white/[0.04] p-4 ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.06]">
            <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[#e5a00d]/15 text-[#e5a00d]">
              <svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 13H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-6c0-.55-.45-1-1-1zM7 19c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM20 3H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1zM7 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>
            </div>
            <div>
              <CreditLink href="https://www.plex.tv">Plex</CreditLink>
              <p className="text-xs text-white/30 mt-0.5">The media server that makes it all possible.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-xl bg-white/[0.04] p-4 ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.06]">
            <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-white/[0.08] text-white/50">
              <svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            </div>
            <div>
              <CreditLink href="https://github.com/agmmnn/tauri-spotify-clone">@agmmnn</CreditLink>
              <p className="text-xs text-white/30 mt-0.5">Original Spotify-clone UI design inspiration.</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <p className="text-center text-[11px] text-white/20 pb-4">
        Made with love and way too much coffee.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Easter eggs section
// ---------------------------------------------------------------------------

function EasterEggsSection() {
  const { rainbow, partyMode, vinylSpin, vaporwave, toggleRainbow, togglePartyMode, toggleVinylSpin, toggleVaporwave } =
    useEasterEggStore()

  return (
    <div className="space-y-6 max-w-2xl">
      <SettingCard title="Easter Eggs" description="Hidden features unlocked by the secret code. Toggle them on and off as you please.">
        <div className="space-y-4">
          <SettingRow label="Rainbow Mode" description="Cycles the accent colour through the rainbow spectrum and adds rainbow gradients to the waveform and volume slider." inline>
            <Toggle label="Rainbow Mode" value={rainbow} onChange={toggleRainbow} />
          </SettingRow>
          <SettingRow label="Party Mode" description="Flashes the app border on each beat when music is playing." inline>
            <Toggle label="Party Mode" value={partyMode} onChange={togglePartyMode} />
          </SettingRow>
          <SettingRow label="Vinyl Spin" description="Makes the album art in the player spin like a vinyl record." inline>
            <Toggle label="Vinyl Spin" value={vinylSpin} onChange={toggleVinylSpin} />
          </SettingRow>
          <SettingRow label="Vaporwave" description="A E S T H E T I C mode. Purple/pink palette with CRT scanlines. Overrides rainbow accent when active." inline>
            <Toggle label="Vaporwave" value={vaporwave} onChange={toggleVaporwave} />
          </SettingRow>
        </div>
      </SettingCard>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main settings page
// ---------------------------------------------------------------------------

const EASTER_EGG_NAV = {
  id: "eastereggs" as Section,
  label: "Easter Eggs",
  icon: (
    <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C8 2 5 7.58 5 12.71 5 16.18 8.13 19 12 19s7-2.82 7-6.29C19 7.58 16 2 12 2zm0 15c-2.76 0-5-1.83-5-4.29C7 8.5 9.48 4 12 4s5 4.5 5 8.71c0 2.46-2.24 4.29-5 4.29z" />
      <path d="M10 9.5c0 .83-.67 1.5-1.5 1.5S7 10.33 7 9.5 7.67 8 8.5 8s1.5.67 1.5 1.5zM14.5 13c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM12 14c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z" />
    </svg>
  ),
}

export function SettingsPage({ section: sectionProp }: { section?: string }) {
  const [, navigate] = useLocation()

  // Map old routes to new ones
  const mappedSection = (() => {
    const raw = sectionProp || "plex"
    if (raw === "experience") return "appearance"
    if (raw === "notifications" || raw === "debug") return "general"
    if (raw === "downloads" || raw === "ai") return "general"
    if (raw === "backends") return "plex"
    if (raw.startsWith("backends/")) return raw.replace("backends/", "metadata/")
    return raw
  })()
  const section: Section = mappedSection as Section

  const setSection = (s: Section) => {
    navigate(s === "plex" ? "/settings" : `/settings/${s}`)
  }

  const navItems = [...NAV, EASTER_EGG_NAV]

  return (
    <div className="flex h-full">
      {/* Inner sidebar */}
      <aside className="w-40 flex-shrink-0 border-r border-white/5 p-3 pt-8 lg:w-52 lg:p-6">
        <p className="mb-4 text-[11px] font-bold uppercase tracking-widest text-white/25">Settings</p>
        <nav aria-label="Settings sections">
          <ul className="space-y-0.5">
            {navItems.map(item => {
              const active = section === item.id || (item.id === "metadata" && section.startsWith("metadata/"))
              return (
                <li key={item.id}>
                  <button
                    aria-current={active ? "page" : undefined}
                    onClick={() => setSection(item.id)}
                    className={clsx(
                      "relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                      active
                        ? "bg-white/10 text-white"
                        : "text-white/50 hover:bg-white/5 hover:text-white"
                    )}
                  >
                    {/* Accent left bar for active item */}
                    {active && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-accent" />
                    )}
                    <span className={clsx("flex-shrink-0 transition-colors", active ? "text-accent" : "text-white/40")}>
                      {item.icon}
                    </span>
                    {item.label}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
      </aside>

      {/* Content */}
      <main className="min-w-0 flex-1 overflow-auto p-4 pt-8 lg:p-10">
        {!section.startsWith("metadata/") && (
          <h1 className="mb-8 text-2xl font-bold">
            {navItems.find(n => n.id === section)?.label}
          </h1>
        )}

        {section === "plex" && <PlexSection />}
        {section === "metadata" && <MetadataListView setSection={setSection} />}
        {section.startsWith("metadata/") && (
          <MetadataSubPage backendId={section.slice(9)} goBack={() => setSection("metadata")} />
        )}
        {section === "appearance" && <AppearanceSection />}
        {section === "cache" && <CacheSection />}
        {section === "general" && <GeneralSection />}
        {section === "about" && <AboutSection />}
        {section === "eastereggs" && <EasterEggsSection />}
      </main>
    </div>
  )
}
