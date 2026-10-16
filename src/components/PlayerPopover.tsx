import { usePlaybackPalette } from "../lib/playbackPaletteContext"
import { createPortal } from "react-dom"
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"

interface Props {
  icon: ReactNode
  label: string
  active?: boolean
  subtitle?: string | null
  width?: number | string
  align?: "left" | "right" | "center"
  disabled?: boolean
  /** Pill-shaped button (auto-width) instead of the default square icon button */
  wide?: boolean
  children: ((close: () => void) => ReactNode) | ReactNode
}

export default function PlayerPopover({
  icon,
  label,
  active,
  subtitle,
  width = 224,
  align = "right",
  disabled,
  wide,
  children,
}: Props) {
  const palette = usePlaybackPalette()
  const [isOpen, setIsOpen] = useState(false)
  const panelId = useId()
  const [pos, setPos] = useState<{ bottom: number; left: number; maxHeight: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  function close() {
    setIsOpen(false)
    buttonRef.current?.focus({ preventScroll: true })
  }

  function toggle() {
    if (isOpen) {
      setIsOpen(false)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const estimatedWidth = typeof width === "number" ? width : 300
    const left = align === "center" ? rect.left + rect.width / 2 - estimatedWidth / 2
      : align === "right" ? rect.right - estimatedWidth : rect.left
    setPos({ bottom: window.innerHeight - rect.top + 8, left: Math.max(8, left), maxHeight: Math.max(80, rect.top - 16) })
    setIsOpen(true)
  }

  // Portalled cards use viewport coordinates and remain within the window as
  // metadata arrives, the window resizes, or their trigger moves.
  useLayoutEffect(() => {
    if (!isOpen) return
    function reposition() {
      const button = buttonRef.current?.getBoundingClientRect()
      const panel = panelRef.current?.getBoundingClientRect()
      if (!button || !panel) return
      const preferred = align === "center" ? button.left + button.width / 2 - panel.width / 2
        : align === "right" ? button.right - panel.width : button.left
      const next = { bottom: window.innerHeight - button.top + 8,
        left: Math.max(8, Math.min(preferred, window.innerWidth - panel.width - 8)),
        maxHeight: Math.max(80, button.top - 16) }
      setPos(previous => previous?.bottom === next.bottom && previous.left === next.left
        && previous.maxHeight === next.maxHeight ? previous : next)
    }
    reposition()
    const observer = new ResizeObserver(reposition)
    if (panelRef.current) observer.observe(panelRef.current)
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", reposition, true)
    panelRef.current?.focus({ preventScroll: true })
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
    }
  }, [isOpen, align, width])

  // Close on outside click (ignoring clicks on the toggle button itself)
  useEffect(() => {
    if (!isOpen) return
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (buttonRef.current?.contains(target)) return
      setIsOpen(false)
    }
    document.addEventListener("mousedown", onMouseDown)
    return () => document.removeEventListener("mousedown", onMouseDown)
  }, [isOpen])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [isOpen])

  return (
    <>
      {/* The document overlay escapes the player's clipping and stacking context. */}
      {isOpen && pos && createPortal(
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          className="app-overlay-surface playback-popover fixed overflow-auto outline-none z-[300] rounded-xl bg-app-card border border-[var(--border)] shadow-2xl shadow-black/40 backdrop-blur-lg select-none"
          style={{
            ...palette,
            bottom: pos.bottom,
            left: pos.left,
            maxHeight: pos.maxHeight,
            maxWidth: "calc(100vw - 16px)",
            width,
          }}
        >
          {typeof children === "function"
            ? (children as (close: () => void) => ReactNode)(close)
            : children}
        </div>, document.body,
      )}

      {/* Toggle button */}
      <div className="relative flex flex-col items-center flex-shrink-0">
        <button
          ref={buttonRef}
          onClick={toggle}
          disabled={disabled}
          title={label}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls={isOpen ? panelId : undefined}
          className={[
            "flex items-center justify-center transition-colors",
            wide
              ? "h-7 rounded-full px-2.5 gap-1.5"
              : "h-8 w-8",
            active || isOpen
              ? wide
                ? "bg-accent/15 border border-accent/40 text-accent"
                : "text-accent"
              : disabled
                ? "text-white/20 cursor-default"
                : wide
                  ? "bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/90"
                  : "text-white/40 hover:text-white/70",
          ].join(" ")}
        >
          {icon}
        </button>
        {subtitle && (
          <span className="absolute top-full mt-0.5 text-[0.5625rem] leading-none font-medium text-accent whitespace-nowrap pointer-events-none">
            {subtitle}
          </span>
        )}
      </div>
    </>
  )
}
