import { useState, useEffect, useRef } from "react"
import { useLocation } from "wouter"
import { open } from "@tauri-apps/plugin-shell"
import clsx from "clsx"
import { audioCacheInfo, audioClearCache, audioSetCacheMaxBytes, audioGetOutputDevices } from "../../lib/audio"
import { clearImageCache, getImageCacheInfo, type ImageCacheInfo } from "../../lib/imageCache"
import { getVersion } from "@tauri-apps/api/app"
import { useAudioSettingsStore } from "../../stores/audioSettingsStore"
import { useUpdateStore } from "../../stores/updateStore"
import { useLastfmStore } from "../../backends/lastfm/authStore"
import { useAccentStore, ACCENT_PRESETS } from "../../stores/accentStore"
import { getTheme, setTheme, subscribeTheme } from "../../stores/themeStore"
import { getFont, setFont, subscribeFont, FONT_PRESETS } from "../../stores/fontStore"
import type { FontPreset } from "../../stores/fontStore"
import { useCardSizeStore, CARD_SIZE_MIN, CARD_SIZE_MAX } from "../../stores/cardSizeStore"
import { useHighlightStore, HIGHLIGHT_DEFAULTS, type HighlightCategory } from "../../stores/highlightStore"
import { useNotificationStore } from "../../stores/notificationStore"
import { useDebugStore } from "../../stores/debugStore"
import { getBackends, getMetadataBackends, getMetadataBackend, getBackend } from "../../backends/registry"
import type { ProviderCapabilities } from "../../providers/types"
import type { MetadataCapabilities, MetadataBackendDefinition, BackendDefinition } from "../../backends/types"
import { useMetadataSourceStore, type MetadataSource, SOURCE_LABELS, SOURCE_DESCRIPTIONS } from "../../stores/metadataSourceStore"

// ---------------------------------------------------------------------------
// Section types & sidebar nav
// ---------------------------------------------------------------------------

type Section =
  | "backends" | `backends/${string}`
  | "playback" | "appearance" | "general" | "about"

const NAV: { id: Section; label: string; icon: React.ReactNode }[] = [
  {
    id: "backends",
    label: "Backends",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20 13H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-6c0-.55-.45-1-1-1zM7 19c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM20 3H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1zM7 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" />
      </svg>
    ),
  },
  {
    id: "playback",
    label: "Playback",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
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

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={clsx(
        "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none",
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
  options,
  value,
  onChange,
  getLabel,
}: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  getLabel: (v: T) => string
}) {
  return (
    <div className="flex gap-2 flex-wrap">
      {options.map((opt, i) => (
        <button
          key={i}
          onClick={() => onChange(opt)}
          className={clsx(
            "rounded-full px-4 py-1.5 text-sm transition-colors",
            value === opt
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

const CACHE_SIZE_KEY = "plexify-audio-cache-max-bytes"

const CACHE_OPTIONS = [
  { label: "256 MB", bytes: 268_435_456 },
  { label: "512 MB", bytes: 536_870_912 },
  { label: "1 GB", bytes: 1_073_741_824 },
  { label: "2 GB", bytes: 2_147_483_648 },
  { label: "4 GB", bytes: 4_294_967_296 },
  { label: "Unlimited", bytes: 0 },
] as const

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

const PREAMP_OPTIONS = [3, 0, -3, -6, -9, -12] as const
const CROSSFADE_OPTIONS = [
  { label: "Off",  ms: 0 },
  { label: "2s",   ms: 2000 },
  { label: "4s",   ms: 4000 },
  { label: "6s",   ms: 6000 },
  { label: "8s",   ms: 8000 },
  { label: "10s",  ms: 10000 },
  { label: "15s",  ms: 15000 },
  { label: "20s",  ms: 20000 },
  { label: "25s",  ms: 25000 },
  { label: "30s",  ms: 30000 },
] as const

function PlaybackSection() {
  const [cacheInfo, setCacheInfo] = useState<{ size_bytes: number; file_count: number } | null>(null)
  const [maxBytes, setMaxBytes] = useState<number>(1_073_741_824)
  const [isClearing, setIsClearing] = useState(false)
  const [outputDevices, setOutputDevices] = useState<string[]>([])

  const {
    normalizationEnabled, setNormalizationEnabled,
    crossfadeWindowMs, setCrossfadeWindowMs,
    crossfadeStyle, setCrossfadeStyle,
    sameAlbumCrossfade, setSameAlbumCrossfade,
    smartCrossfade, setSmartCrossfade,
    preampDb, setPreampDb,
    albumGainMode, setAlbumGainMode,
    preferredDevice, setPreferredDevice,
  } = useAudioSettingsStore()

  useEffect(() => {
    const saved = localStorage.getItem(CACHE_SIZE_KEY)
    const savedBytes = saved !== null ? parseInt(saved, 10) : 1_073_741_824
    if (!isNaN(savedBytes)) {
      setMaxBytes(savedBytes)
      void audioSetCacheMaxBytes(savedBytes).catch(() => {})
    }
    void audioCacheInfo().then(info => setCacheInfo(info)).catch(() => {})
    void audioGetOutputDevices().then(devs => setOutputDevices(devs)).catch(() => {})
  }, [])

  async function handleMaxChange(bytes: number) {
    setMaxBytes(bytes)
    localStorage.setItem(CACHE_SIZE_KEY, String(bytes))
    await audioSetCacheMaxBytes(bytes).catch(() => {})
  }

  async function handleClear() {
    setIsClearing(true)
    try {
      await audioClearCache()
      const info = await audioCacheInfo()
      setCacheInfo(info)
    } finally {
      setIsClearing(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 max-w-2xl">

      {/* Audio Processing */}
      <SettingCard title="Audio Processing">
        <div className="flex flex-col gap-5">
          <SettingRow label="Normalization" description="Volume-levels tracks using ReplayGain data so loud and quiet tracks play at a consistent loudness." inline>
            <Toggle value={normalizationEnabled} onChange={setNormalizationEnabled} />
          </SettingRow>

          <SettingRow label="ReplayGain Mode" description="Track mode normalises each track independently. Album mode preserves intended loudness differences between tracks on the same album.">
            <PillGroup
              options={[false, true] as const}
              value={albumGainMode}
              onChange={setAlbumGainMode}
              getLabel={v => v ? "Album" : "Track"}
            />
          </SettingRow>

          <SettingRow label="Pre-amp" description="Adjust the output level before the EQ. Lower this if heavy EQ boosts cause clipping.">
            <PillGroup
              options={PREAMP_OPTIONS}
              value={preampDb}
              onChange={setPreampDb}
              getLabel={db => `${db > 0 ? `+${db}` : db} dB`}
            />
          </SettingRow>
        </div>
      </SettingCard>

      {/* Crossfade */}
      <SettingCard title="Crossfade">
        <div className="flex flex-col gap-5">
          <SettingRow label={smartCrossfade && crossfadeWindowMs > 0 ? "Maximum duration (min 2s)" : "Duration"}>
            <PillGroup
              options={CROSSFADE_OPTIONS}
              value={CROSSFADE_OPTIONS.find(o => o.ms === crossfadeWindowMs) ?? CROSSFADE_OPTIONS[0]}
              onChange={opt => setCrossfadeWindowMs(opt.ms)}
              getLabel={opt => opt.label}
            />
          </SettingRow>

          {crossfadeWindowMs > 0 && (
            <SettingRow label="Style" description="Controls how the two tracks are blended during a crossfade transition.">
              <PillGroup
                options={[
                  { value: 0, label: "Smooth" },
                  { value: 1, label: "DJ Filter" },
                  { value: 2, label: "Echo Out" },
                  { value: 3, label: "Hard Cut" },
                ] as const}
                value={([
                  { value: 0, label: "Smooth" },
                  { value: 1, label: "DJ Filter" },
                  { value: 2, label: "Echo Out" },
                  { value: 3, label: "Hard Cut" },
                ] as const).find(o => o.value === crossfadeStyle) ?? { value: 0, label: "Smooth" }}
                onChange={opt => setCrossfadeStyle(opt.value)}
                getLabel={opt => opt.label}
              />
            </SettingRow>
          )}

          {crossfadeWindowMs > 0 && (
            <SettingRow label="Smart crossfade" description="Analyses tracks to skip trailing silence, align crossfades to natural fade-outs, and adapt duration to each transition." inline>
              <Toggle value={smartCrossfade} onChange={setSmartCrossfade} />
            </SettingRow>
          )}

          <SettingRow label="Same-album tracks" description="Suppressing crossfade preserves gapless playback for live albums and classical works.">
            <PillGroup
              options={[false, true] as const}
              value={sameAlbumCrossfade}
              onChange={setSameAlbumCrossfade}
              getLabel={v => v ? "Allow" : "Suppress"}
            />
          </SettingRow>
        </div>
      </SettingCard>

      {/* Output Device */}
      <SettingCard title="Output Device" description="Select which audio device to use for playback. Takes effect on the next track.">
        {outputDevices.length === 0 ? (
          <p className="text-xs text-white/30">No output devices found.</p>
        ) : (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setPreferredDevice(null)}
              className={clsx(
                "rounded-full px-4 py-1.5 text-sm transition-colors",
                preferredDevice === null
                  ? "bg-accent text-black font-semibold"
                  : "bg-white/10 text-white hover:bg-white/20"
              )}
            >
              System Default
            </button>
            {outputDevices.map(dev => (
              <button
                key={dev}
                onClick={() => setPreferredDevice(dev)}
                className={clsx(
                  "rounded-full px-4 py-1.5 text-sm transition-colors",
                  preferredDevice === dev
                    ? "bg-accent text-black font-semibold"
                    : "bg-white/10 text-white hover:bg-white/20"
                )}
              >
                {dev}
              </button>
            ))}
          </div>
        )}
      </SettingCard>

      {/* Audio Cache */}
      <SettingCard title="Audio Cache">
        <div className="flex flex-col gap-5">
          <SettingRow label="Cache Size Limit" description="Tracks are cached to disk for instant replay. Older files are removed automatically when the limit is reached.">
            <PillGroup
              options={CACHE_OPTIONS}
              value={CACHE_OPTIONS.find(o => o.bytes === maxBytes) ?? CACHE_OPTIONS[2]}
              onChange={opt => void handleMaxChange(opt.bytes)}
              getLabel={opt => opt.label}
            />
          </SettingRow>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-white/80">Cache Usage</p>
              {cacheInfo ? (
                <p className="text-xs text-white/40 mt-0.5">
                  {formatBytes(cacheInfo.size_bytes)} used · {cacheInfo.file_count} {cacheInfo.file_count === 1 ? "file" : "files"}
                </p>
              ) : (
                <p className="text-xs text-white/30 mt-0.5">Loading…</p>
              )}
            </div>
            <button
              onClick={() => void handleClear()}
              disabled={isClearing || cacheInfo?.file_count === 0}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:border-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            >
              {isClearing ? "Clearing…" : "Clear Cache"}
            </button>
          </div>
        </div>
      </SettingCard>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Appearance section (was Experience)
// ---------------------------------------------------------------------------

function AppearanceSection() {
  const { accent, setAccent } = useAccentStore()
  const [custom, setCustom] = useState(accent)
  const [theme, setThemeState] = useState(getTheme)
  const [font, setFontState] = useState<FontPreset>(getFont)
  const { cardSize, setCardSize } = useCardSizeStore()

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
          options={["dark", "light", "system"] as const}
          value={theme}
          onChange={setTheme}
          getLabel={t => t.charAt(0).toUpperCase() + t.slice(1)}
        />
      </SettingCard>

      {/* Font */}
      <SettingCard title="Font" description="Pick a typeface for the entire interface.">
        <div className="flex flex-wrap gap-2">
          {FONT_PRESETS.map(preset => (
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

        {/* Live preview strip */}
        <div className="mt-6 rounded-xl bg-white/5 p-4 flex items-center gap-4 border border-white/5">
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
            className="flex-1 accent-[var(--accent)] cursor-pointer"
          />
          <span className="text-sm font-mono text-white/60 w-14 text-right">{cardSize}px</span>
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-xs text-white/25">Small</span>
          <span className="text-xs text-white/25">Large</span>
        </div>
      </SettingCard>

      {/* Highlight Intensity */}
      <HighlightCard />
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
          className="flex-1 accent-[var(--accent)] cursor-pointer"
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
                    className="flex-1 accent-[var(--accent)] cursor-pointer"
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
// General section (Notifications + Debug + Coming Soon placeholders)
// ---------------------------------------------------------------------------

function GeneralSection() {
  const { notificationsEnabled, setNotificationsEnabled } = useNotificationStore()
  const { debugEnabled, setDebugEnabled } = useDebugStore()

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <SettingCard title="Preferences">
        <div className="flex flex-col gap-5">
          <SettingRow
            label="Track Notifications"
            description="Show an OS notification when a new track starts playing."
            inline
          >
            <Toggle value={notificationsEnabled} onChange={setNotificationsEnabled} />
          </SettingRow>

          <div className="border-t border-white/[0.06]" />

          <SettingRow
            label="Debug Mode"
            description="Shows raw Plex IDs, file paths, and stream data in track info and right-click menus."
            inline
          >
            <Toggle value={debugEnabled} onChange={setDebugEnabled} />
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
}

function CapabilityGrid({ caps, labels }: { caps: { [k: string]: boolean }; labels: { [k: string]: string } }) {
  const entries = Object.entries(labels)
  return (
    <div className="grid grid-cols-3 gap-2">
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

function BackendsListView({ setSection }: { setSection: (s: Section) => void }) {
  const backends = getBackends()
  const metadataBackends = getMetadataBackends()
  const { hasApiKey: lastfmHasApiKey } = useLastfmStore()
  const { priority, setPriority } = useMetadataSourceStore()

  const [imgCacheInfo, setImgCacheInfo] = useState<ImageCacheInfo | null>(null)
  const [imgClearing, setImgClearing] = useState(false)

  // Pointer-based drag for source priority
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const sortListRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void getImageCacheInfo().then(setImgCacheInfo).catch(() => {})
  }, [])

  async function handleClearImages() {
    setImgClearing(true)
    try {
      await clearImageCache()
      const info = await getImageCacheInfo()
      setImgCacheInfo(info)
    } finally {
      setImgClearing(false)
    }
  }

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

      {/* Music Backends */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/25 mb-4">Music Backends</h3>
        <div className="space-y-3">
          {backends.map(backend => {
            const connected = backend.useIsConnected()
            const Icon = backend.icon
            return (
              <button
                key={backend.id}
                onClick={() => setSection(`backends/${backend.id}` as Section)}
                className="w-full rounded-xl bg-white/5 px-5 py-4 text-left hover:bg-white/8 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <span className="text-white/60"><Icon size={20} /></span>
                  <span className="text-sm font-semibold text-white">{backend.name}</span>
                  <span className="ml-auto flex items-center gap-1.5 text-xs">
                    <span className={`h-2 w-2 rounded-full ${connected ? "bg-accent" : "bg-white/20"}`} />
                    <span className={connected ? "text-accent" : "text-white/30"}>
                      {connected ? "Connected" : "Not connected"}
                    </span>
                  </span>
                  <svg height="14" width="14" viewBox="0 0 24 24" fill="currentColor" className="text-white/20 group-hover:text-white/40 transition-colors">
                    <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
                  </svg>
                </div>
                <p className="mt-1.5 text-xs text-white/35">{backend.description}</p>
              </button>
            )
          })}
        </div>
      </div>

      {/* Metadata Backends */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/25 mb-4">Metadata Backends</h3>
        <div className="space-y-3">
          {metadataBackends.map(mb => {
            const enabled = mb.useIsEnabled()
            const Icon = mb.icon
            return (
              <button
                key={mb.id}
                onClick={() => setSection(`backends/${mb.id}` as Section)}
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

      {/* Image Cache */}
      <SettingCard title="Image Cache" description="Artwork fetched from Plex and external metadata sources is saved to disk.">
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white">Cached Images</p>
            <p className="text-xs text-white/40 mt-0.5">
              {imgCacheInfo
                ? `${formatBytes(imgCacheInfo.bytes)} · ${imgCacheInfo.files} ${imgCacheInfo.files === 1 ? "file" : "files"}`
                : "Loading..."}
            </p>
          </div>
          <button
            onClick={() => void handleClearImages()}
            disabled={imgClearing || (imgCacheInfo?.files ?? 0) === 0}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:border-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            {imgClearing ? "Clearing..." : "Clear"}
          </button>
        </div>
      </SettingCard>
    </div>
  )
}

function BackendSubPage({ backendId, goBack }: { backendId: string; goBack: () => void }) {
  const musicBackend = getBackend(backendId)
  const metaBackend = getMetadataBackend(backendId)

  if (!musicBackend && !metaBackend) {
    return (
      <div className="max-w-2xl">
        <button onClick={goBack} className="mb-6 flex items-center gap-1.5 text-sm text-white/50 hover:text-white transition-colors">
          <svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></svg>
          Back to Backends
        </button>
        <p className="text-sm text-white/50">Backend not found.</p>
      </div>
    )
  }

  const name = musicBackend?.name ?? metaBackend!.name
  const Icon = musicBackend?.icon ?? metaBackend!.icon
  const Settings = musicBackend?.SettingsComponent ?? metaBackend!.SettingsComponent

  return (
    <div className="max-w-2xl space-y-8">
      {/* Back button + header */}
      <div>
        <button onClick={goBack} className="mb-4 flex items-center gap-1.5 text-sm text-white/50 hover:text-white transition-colors">
          <svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></svg>
          Back to Backends
        </button>
        <div className="flex items-center gap-3">
          <span className="text-white/60"><Icon size={24} /></span>
          <h2 className="text-2xl font-bold">{name}</h2>
        </div>
      </div>

      {/* Capabilities */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/25 mb-4">Capabilities</h3>
        {musicBackend ? (
          <CapabilityGrid caps={musicBackend.capabilities as unknown as { [k: string]: boolean }} labels={CAPABILITY_LABELS} />
        ) : metaBackend ? (
          <CapabilityGrid caps={metaBackend.capabilities as unknown as { [k: string]: boolean }} labels={METADATA_CAPABILITY_LABELS} />
        ) : null}
      </div>

      {/* Settings */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/25 mb-4">Settings</h3>
        <Settings />
      </div>
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

function AboutSection() {
  const [version, setVersion] = useState("")
  const { update, checking, error, lastChecked, checkForUpdate, setShowDialog } = useUpdateStore()

  useEffect(() => {
    void getVersion().then(setVersion)
  }, [])

  return (
    <div className="flex gap-12 max-w-4xl">
      {/* Left column — version, updates, links */}
      <div className="flex flex-col gap-6 min-w-[320px] max-w-md">
        {/* Version */}
        <SettingCard title="Version">
          <p className="text-sm text-white/70">
            Plexify <span className="font-semibold text-white">{version || "\u2026"}</span>
          </p>
        </SettingCard>

        {/* Updates */}
        <SettingCard title="Updates">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => void checkForUpdate()}
                disabled={checking}
                className="rounded-full px-4 py-1.5 text-sm bg-white/10 text-white hover:bg-white/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
                  <p className="text-sm font-semibold text-accent">
                    Version {update.version} available
                  </p>
                  {update.body && (
                    <p className="text-xs text-white/40 mt-0.5 line-clamp-1">{update.body}</p>
                  )}
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
              <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}
          </div>
        </SettingCard>

        {/* Links */}
        <SettingCard title="Links">
          <div className="flex flex-col gap-2 text-sm">
            <CreditLink href="https://github.com/karbowiak/plexify">GitHub Repository</CreditLink>
            <CreditLink href="https://github.com/karbowiak/plexify/releases">Release Notes</CreditLink>
          </div>
        </SettingCard>
      </div>

      {/* Right column — thank you / credits */}
      <div className="flex-1 min-w-[260px]">
        <SettingCard title="Thank You">
          <p className="text-sm text-white/50 mb-5">
            Plexify wouldn't exist without these incredible projects and people.
          </p>

          <div className="flex flex-col gap-5">
            {/* Special thanks */}
            <div className="rounded-xl bg-white/5 border border-white/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-white/30 mb-3">Special Thanks</p>
              <ul className="space-y-2 text-sm">
                <li className="text-white/70">
                  <CreditLink href="https://www.plex.tv">Plex</CreditLink>
                  <span className="text-white/30"> &mdash; the media server that makes it all possible</span>
                </li>
                <li className="text-white/70">
                  <CreditLink href="https://github.com/agmmnn/tauri-spotify-clone">@agmmnn</CreditLink>
                  <span className="text-white/30"> &mdash; original Spotify-clone UI design inspiration</span>
                </li>
              </ul>
            </div>

            {/* Core framework */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-white/30 mb-3">Core</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                <CreditLink href="https://v2.tauri.app">Tauri</CreditLink>
                <CreditLink href="https://react.dev">React</CreditLink>
                <CreditLink href="https://www.typescriptlang.org">TypeScript</CreditLink>
                <CreditLink href="https://www.rust-lang.org">Rust</CreditLink>
                <CreditLink href="https://vitejs.dev">Vite</CreditLink>
              </div>
            </div>

            {/* Audio */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-white/30 mb-3">Audio Engine</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                <CreditLink href="https://github.com/pdeljanov/Symphonia">Symphonia</CreditLink>
                <CreditLink href="https://github.com/RustAudio/cpal">cpal</CreditLink>
                <CreditLink href="https://github.com/jprjr/butterchurn">Butterchurn</CreditLink>
                <CreditLink href="https://github.com/Amanieu/ringbuf">ringbuf</CreditLink>
              </div>
            </div>

            {/* Frontend */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-white/30 mb-3">Frontend</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                <CreditLink href="https://tailwindcss.com">Tailwind CSS</CreditLink>
                <CreditLink href="https://zustand.docs.pmnd.rs">Zustand</CreditLink>
                <CreditLink href="https://github.com/molefrog/wouter">Wouter</CreditLink>
                <CreditLink href="https://dndkit.com">dnd kit</CreditLink>
              </div>
            </div>

            {/* Backend */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-white/30 mb-3">Backend</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                <CreditLink href="https://tokio.rs">Tokio</CreditLink>
                <CreditLink href="https://github.com/seanmonstar/reqwest">reqwest</CreditLink>
                <CreditLink href="https://serde.rs">Serde</CreditLink>
                <CreditLink href="https://github.com/Sinono3/souvlaki">Souvlaki</CreditLink>
              </div>
            </div>
          </div>
        </SettingCard>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main settings page
// ---------------------------------------------------------------------------

export function SettingsPage({ section: sectionProp }: { section?: string }) {
  const [, navigate] = useLocation()

  // Map old routes to new ones
  const mappedSection = (() => {
    const raw = sectionProp || "backends"
    if (raw === "experience") return "appearance"
    if (raw === "notifications" || raw === "debug") return "general"
    if (raw === "downloads" || raw === "ai") return "general"
    return raw
  })()
  const section: Section = mappedSection as Section

  const setSection = (s: Section) => {
    navigate(s === "backends" ? "/settings" : `/settings/${s}`)
  }

  return (
    <div className="flex h-full">
      {/* Inner sidebar */}
      <aside className="w-52 flex-shrink-0 border-r border-white/5 p-6 pt-8">
        <p className="mb-4 text-[11px] font-bold uppercase tracking-widest text-white/25">Settings</p>
        <nav>
          <ul className="space-y-0.5">
            {NAV.map(item => {
              const active = section === item.id || (item.id === "backends" && section.startsWith("backends/"))
              return (
                <li key={item.id}>
                  <button
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
      <main className="flex-1 overflow-auto p-10 pt-8">
        {!section.startsWith("backends/") && (
          <h1 className="mb-8 text-2xl font-bold">
            {NAV.find(n => n.id === section)?.label}
          </h1>
        )}

        {section === "backends" && <BackendsListView setSection={setSection} />}
        {section.startsWith("backends/") && (
          <BackendSubPage backendId={section.slice(9)} goBack={() => navigate("/settings")} />
        )}
        {section === "playback" && <PlaybackSection />}
        {section === "appearance" && <AppearanceSection />}
        {section === "general" && <GeneralSection />}
        {section === "about" && <AboutSection />}
      </main>
    </div>
  )
}
