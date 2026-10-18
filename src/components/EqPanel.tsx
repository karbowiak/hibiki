import { Button } from "./shared/Button"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useEqStore, EQ_LABELS, EQ_PRESETS } from "../stores/eqStore"
import { useDeviceStore } from "../stores/deviceStore"
import { PlayerPanelHeader } from "./shared/PlayerPanelHeader"
import { DeviceCorrectionPanel } from "./DeviceCorrectionPanel"

const MIN_DB = -12
const MAX_DB = 12
const DB_RANGE = MAX_DB - MIN_DB
const BAR_HEIGHT = 200

function dbToY(db: number): number {
  return ((MAX_DB - db) / DB_RANGE) * BAR_HEIGHT
}

function formatDb(db: number): string {
  if (db > 0) return `+${db}`
  return `${db}`
}

/** Custom visual gain slider with accent fill and glow thumb. */
function GainSlider({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  disabled: boolean
}) {
  const pct = ((value + 24) / 48) * 100
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[10px] text-(--text-muted)">
        {label}
      </span>
      <div
        className="relative flex flex-1 items-center rounded-md focus-within:ring-2 focus-within:ring-accent"
        style={{ height: 20 }}
      >
        {/* Track background */}
        <div className="absolute inset-x-0 h-[3px] rounded-full bg-(--border)" />
        {/* Filled portion */}
        <div
          className="absolute left-0 h-[3px] rounded-full bg-accent/40"
          style={{ width: `${pct}%` }}
        />
        {/* Native range input (invisible, handles interaction) */}
        <input
          type="range"
          min={-24}
          max={24}
          step={0.5}
          value={value}
          disabled={disabled}
          onInput={(e) => {
            if (!disabled && useEqStore.getState().enabled)
              onChange(e.currentTarget.valueAsNumber)
          }}
          className="absolute inset-0 w-full cursor-pointer opacity-0"
          aria-label={label}
          aria-valuetext={`${formatDb(value)} dB`}
        />
        {/* Visual thumb */}
        <div
          className="pointer-events-none absolute h-3 w-3 rounded-full bg-accent"
          style={{
            left: `calc(${pct}% - 6px)`,
            boxShadow: "0 0 6px rgb(var(--accent-rgb) / 0.15)",
          }}
        />
      </div>
      <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-(--text-muted)">
        {value > 0 ? "+" : ""}
        {value} dB
      </span>
    </div>
  )
}

interface Props {
  onClose: () => void
}

export default function EqPanel({ onClose }: Props) {
  const {
    gains,
    enabled,
    setEnabled,
    setBand,
    applyPreset,
    postgainDb,
    autoPostgain,
    setPostgainDb,
    setAutoPostgain,
    applying,
    eqError,
    syncToEngine,
    currentDevice,
    deviceProfiles,
    saveProfileForDevice,
    deleteProfileForDevice,
    currentOutput,
    correctionEnabled,
    selectedCorrectionId,
    correctionPreview,
  } = useEqStore()

  const { currentDevice: deviceStoreDevice } = useDeviceStore()
  const [tab, setTab] = useState<"tone" | "correction">("tone")
  const panelId = useId()
  const correctionTab = tab === "correction" && !!currentOutput
  const correctionActive = !!correctionPreview || correctionEnabled && !!selectedCorrectionId
  const profileDevices = Object.keys(deviceProfiles)
  const barRefs = useRef<(HTMLDivElement | null)[]>([])

  const dragCleanup = useRef<(() => void) | null>(null)

  useEffect(() => () => dragCleanup.current?.(), [])
  useEffect(() => {
    if (!enabled || correctionTab) dragCleanup.current?.()
  }, [enabled, correctionTab])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, index: number) => {
      if (
        !useEqStore.getState().enabled ||
        event.button !== 0 ||
        event.isPrimary === false
      )
        return
      dragCleanup.current?.()
      event.preventDefault()
      const element = event.currentTarget
      const pointerId = event.pointerId
      const top = element.getBoundingClientRect().top
      const update = (clientY: number) => {
        if (!useEqStore.getState().enabled) return
        const y = Math.max(0, Math.min(BAR_HEIGHT, clientY - top))
        setBand(index, Math.round(MAX_DB - (y / BAR_HEIGHT) * DB_RANGE))
      }
      element.focus({ preventScroll: true })
      const onMove = (move: PointerEvent) => {
        if (move.pointerId === pointerId) update(move.clientY)
      }
      const cleanup = () => {
        element.removeEventListener("pointermove", onMove)
        element.removeEventListener("pointerup", onEnd)
        element.removeEventListener("pointercancel", onEnd)
        element.removeEventListener("lostpointercapture", onEnd)
        if (dragCleanup.current === cleanup) dragCleanup.current = null
        // The platform can retire the pointer while the panel is closing.
        try {
          if (element.hasPointerCapture(pointerId))
            element.releasePointerCapture(pointerId)
        } catch {
          /* The listeners are already detached. */
        }
      }
      const onEnd = (end: PointerEvent) => {
        if (end.pointerId === pointerId) cleanup()
      }
      try {
        element.setPointerCapture(pointerId)
      } catch {
        return
      }
      dragCleanup.current = cleanup
      element.addEventListener("pointermove", onMove)
      element.addEventListener("pointerup", onEnd)
      element.addEventListener("pointercancel", onEnd)
      element.addEventListener("lostpointercapture", onEnd)
      update(event.clientY)
    },
    [setBand]
  )

  // React delegates wheel events passively; install cancellable handlers so
  // an EQ change cannot also scroll the surrounding page or popover.
  useEffect(() => {
    const registrations = barRefs.current.flatMap((element, index) => {
      if (!element) return []
      const handler = (event: WheelEvent) => {
        const current = useEqStore.getState()
        if (!current.enabled || event.deltaY === 0 || event.ctrlKey) return
        event.preventDefault()
        event.stopPropagation()
        const delta = event.deltaY < 0 ? 1 : -1
        setBand(
          index,
          Math.max(MIN_DB, Math.min(MAX_DB, current.gains[index] + delta))
        )
      }
      element.addEventListener("wheel", handler, { passive: false })
      return [{ element, handler }]
    })
    return () =>
      registrations.forEach(({ element, handler }) =>
        element.removeEventListener("wheel", handler)
      )
  }, [setBand])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, index: number) => {
      const current = useEqStore.getState()
      if (!current.enabled) return
      let value = current.gains[index]
      switch (event.key) {
        case "ArrowUp":
        case "ArrowRight":
          value += 1
          break
        case "ArrowDown":
        case "ArrowLeft":
          value -= 1
          break
        case "PageUp":
          value += 3
          break
        case "PageDown":
          value -= 3
          break
        case "Home":
          value = MIN_DB
          break
        case "End":
          value = MAX_DB
          break
        default:
          return
      }
      event.preventDefault()
      event.stopPropagation()
      setBand(index, Math.max(MIN_DB, Math.min(MAX_DB, value)))
    },
    [setBand]
  )

  return (
    <>
      {/* Header */}
      <PlayerPanelHeader title="Equalizer" onClose={onClose} actions={!correctionTab ? <>
          <Button
            variant="bare"
            onClick={() => applyPreset([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])}
            className="player-panel-action"
          >
            Reset
          </Button>
          <Button
            variant="bare"
            onClick={() => setEnabled(!enabled)}
            aria-pressed={enabled}
            aria-label="Tone equalizer"
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              enabled
                ? "bg-accent text-(--bg-base)"
                : "bg-(--bg-surface) text-(--text-muted)"
            }`}
          >
            {enabled ? "Tone on" : "Tone off"}
          </Button>
        </> : undefined} />

      {eqError && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-(--border) px-4 py-2 text-xs text-(--text-primary)"
        >
          <span>{eqError}</span>
          <Button
            variant="bare"
            onClick={syncToEngine}
            className="shrink-0 text-accent underline"
          >
            Retry
          </Button>
        </div>
      )}

      {/* Active output device */}
      {(currentDevice || deviceStoreDevice) && (
        <div className="flex items-center gap-2 border-b border-(--border) px-4 py-2">
          <span className="shrink-0 text-[10px] text-(--text-muted)">
            Output
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-(--text-primary)">
            {currentDevice || deviceStoreDevice || "System default"}
          </span>
        </div>
      )}

      {currentOutput && <div role="tablist" aria-label="Equalizer controls" className="flex gap-1 border-b border-(--border) px-4 py-2">
        {(["tone", "correction"] as const).map(value => <Button variant="bare"
          key={value} type="button" role="tab" id={`${panelId}-${value}`} aria-controls={`${panelId}-${value}-panel`}
          aria-selected={value === (correctionTab ? "correction" : "tone")} tabIndex={value === (correctionTab ? "correction" : "tone") ? 0 : -1}
          onClick={() => setTab(value)}
          onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
            event.preventDefault()
            const next = event.key === "Home" ? "tone" : event.key === "End" ? "correction" : value === "tone" ? "correction" : "tone"
            setTab(next)
            document.getElementById(`${panelId}-${next}`)?.focus()
          }}
          className={`flex min-h-9 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${value === (correctionTab ? "correction" : "tone") ? "bg-(--accent-tint-subtle) text-accent" : "text-(--text-secondary) hover:bg-(--bg-surface-hover)"}`}
        >{value === "tone" ? "Tone" : "Device correction"}
          {value === "correction" && <span aria-label={correctionActive ? "Correction enabled" : "Correction bypassed"} className={`h-1.5 w-1.5 rounded-full ${correctionActive ? "bg-accent" : "bg-(--text-muted)"}`} />}
        </Button>)}
      </div>}

      <div id={`${panelId}-tone-panel`} role={currentOutput ? "tabpanel" : undefined} aria-labelledby={currentOutput ? `${panelId}-tone` : undefined} hidden={correctionTab}>
      {/* Preset grid */}
      <div
        className={`grid grid-cols-3 gap-1.5 border-b border-(--border) px-4 py-3 transition-opacity ${!enabled ? "pointer-events-none opacity-40" : ""}`}
      >
        {EQ_PRESETS.map((preset) => {
          const active = preset.gains.every(
            (g, i) => Math.abs(g - gains[i]) < 0.01
          )
          return (
            <Button
              variant="bare"
              key={preset.name}
              onClick={() => applyPreset(preset.gains)}
              disabled={!enabled}
              aria-pressed={active}
              className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-all ${
                active
                  ? "border-accent/50 text-accent"
                  : "border-(--border) text-(--text-muted) hover:text-(--text-secondary)"
              }`}
              style={{
                background: active
                  ? "var(--accent-tint-strong)"
                  : "var(--accent-tint-subtle)",
                ...(active
                  ? { boxShadow: "0 0 8px rgb(var(--accent-rgb) / 0.15)" }
                  : {}),
              }}
            >
              {preset.name}
            </Button>
          )
        })}
      </div>

      {/* EQ Bars */}
      <div
        className={`px-4 pb-2 pt-4 transition-opacity ${!enabled ? "pointer-events-none opacity-40" : ""}`}
      >
        <div className="relative flex items-start justify-between gap-1">
          {/* 0dB reference line */}
          <div
            className="pointer-events-none absolute left-0 right-0 border-t border-(--border)"
            style={{ top: `calc(24px + ${BAR_HEIGHT / 2}px)` }}
          />

          {gains.map((db, i) => {
            const centerY = BAR_HEIGHT / 2
            const currentY = dbToY(db)
            const fillTop = db >= 0 ? currentY : centerY
            const fillHeight = db >= 0 ? centerY - currentY : currentY - centerY

            return (
              <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                {/* dB value */}
                <span
                  className={`h-4 text-[10px] tabular-nums leading-4 ${
                    db === 0
                      ? "text-(--text-muted)"
                      : "text-(--text-primary)"
                  }`}
                >
                  {formatDb(db)}
                </span>

                {/* Bar */}
                <div
                  ref={(el) => {
                    barRefs.current[i] = el
                  }}
                  role="slider"
                  tabIndex={enabled ? 0 : -1}
                  aria-disabled={!enabled}
                  aria-orientation="vertical"
                  aria-valuetext={`${formatDb(db)} dB`}
                  aria-valuemin={MIN_DB}
                  aria-valuemax={MAX_DB}
                  aria-valuenow={db}
                  aria-label={`${EQ_LABELS[i].endsWith("K") ? `${EQ_LABELS[i].slice(0, -1)} kHz` : `${EQ_LABELS[i]} Hz`} band`}
                  className="relative cursor-pointer touch-none overflow-hidden rounded-md bg-(--bg-surface) focus-visible:ring-2 focus-visible:ring-accent"
                  style={{ width: "100%", maxWidth: 32, height: BAR_HEIGHT }}
                  onPointerDown={(e) => handlePointerDown(e, i)}
                  onDoubleClick={() => enabled && setBand(i, 0)}
                  onKeyDown={(e) => handleKeyDown(e, i)}
                >
                  {/* Fill from center */}
                  {fillHeight > 0 && (
                    <div
                      className="absolute left-1 right-1 rounded-sm bg-accent/30"
                      style={{ top: fillTop, height: fillHeight }}
                    />
                  )}

                  {/* Thumb line */}
                  <div
                    className="absolute left-0.5 right-0.5 h-[3px] rounded-full bg-accent"
                    style={{
                      top: currentY - 1.5,
                      boxShadow: "0 0 6px rgb(var(--accent-rgb) / 0.15)",
                    }}
                  />
                </div>

                {/* Frequency label */}
                <span className="text-[9px] tabular-nums text-(--text-muted)">
                  {EQ_LABELS[i]}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Gain controls */}
      <div
        className={`space-y-2 border-t border-(--border) px-4 py-3 transition-opacity ${!enabled ? "pointer-events-none opacity-40" : ""}`}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-(--text-muted)">
            Gain
          </span>
          <Button
            variant="bare"
            onClick={() => setAutoPostgain(!autoPostgain)}
            disabled={!enabled}
            aria-pressed={autoPostgain}
            title="Reduce gain to compensate for EQ boosts"
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors ${
              autoPostgain
                ? "bg-accent text-(--bg-base)"
                : "bg-(--bg-surface) text-(--text-muted) hover:bg-(--bg-surface-hover)"
            }`}
          >
            Auto
          </Button>
          {autoPostgain && (
            <span className="text-[11px] tabular-nums text-(--text-muted)">
              {applying
                ? "Applying…"
                : `${postgainDb > 0 ? "+" : ""}${postgainDb.toFixed(1)} dB`}
            </span>
          )}
        </div>
        {!autoPostgain && (
          <GainSlider
            label="Postgain"
            value={postgainDb}
            onChange={setPostgainDb}
            disabled={!enabled}
          />
        )}
      </div>
      </div>

      {/* Device Profiles */}
      {currentOutput && <div id={`${panelId}-correction-panel`} role="tabpanel" aria-labelledby={`${panelId}-correction`} hidden={!correctionTab}>{correctionTab && <DeviceCorrectionPanel />}</div>}
      {!currentOutput && currentDevice && (
        <div className="border-t border-(--border) px-4 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-(--text-muted)">
            Device Profiles
          </span>
          <div className="mt-1.5 flex flex-col gap-1">
            {/* Always show current device first */}
            {(() => {
              const hasProfile = Object.hasOwn(deviceProfiles, currentDevice)
              return (
                <div className="flex items-center gap-2 rounded bg-(--accent-tint-subtle) px-2 py-1 text-xs">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="flex-1 truncate text-(--text-primary)">
                    {currentDevice}
                  </span>
                  {hasProfile && (
                    <svg
                      className="h-3 w-3 shrink-0 text-accent"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                    >
                      <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                    </svg>
                  )}
                  <Button
                    variant="bare"
                    onClick={() => saveProfileForDevice(currentDevice)}
                    className="shrink-0 rounded bg-(--bg-surface) px-1.5 py-0.5 text-[10px] text-(--text-muted) transition-colors hover:bg-(--bg-surface-hover) hover:text-(--text-primary)"
                  >
                    Save
                  </Button>
                  {hasProfile && (
                    <Button
                      variant="bare"
                      onClick={() => deleteProfileForDevice(currentDevice)}
                      className="shrink-0 rounded bg-(--bg-surface) px-1.5 py-0.5 text-[10px] text-(--text-muted) transition-colors hover:bg-red-500/20 hover:text-red-400"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              )
            })()}
            {/* Other saved profiles */}
            {profileDevices
              .filter((d) => d !== currentDevice)
              .map((dev) => (
                <div
                  key={dev}
                  className="flex items-center gap-2 rounded px-2 py-1 text-xs"
                >
                  <span className="flex-1 truncate text-(--text-muted)">
                    {dev}
                  </span>
                  <svg
                    className="h-3 w-3 shrink-0 text-accent"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                  >
                    <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                  </svg>
                  <Button
                    variant="bare"
                    onClick={() => deleteProfileForDevice(dev)}
                    className="shrink-0 rounded bg-(--bg-surface) px-1.5 py-0.5 text-[10px] text-(--text-muted) transition-colors hover:bg-red-500/20 hover:text-red-400"
                  >
                    Clear
                  </Button>
                </div>
              ))}
          </div>
        </div>
      )}
    </>
  )
}
