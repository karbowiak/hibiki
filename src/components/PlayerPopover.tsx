import { useEffect, useRef, useState, type ReactNode } from "react"

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
  const [isOpen, setIsOpen] = useState(false)
  const [pos, setPos] = useState<{ bottom: number; left?: number; right?: number; centerX?: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  function close() {
    setIsOpen(false)
  }

  function toggle() {
    if (isOpen) {
      setIsOpen(false)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const bottom = window.innerHeight - rect.top + 8
    if (align === "center") {
      setPos({ bottom, centerX: rect.left + rect.width / 2 })
    } else if (align === "right") {
      setPos({ bottom, right: window.innerWidth - rect.right })
    } else {
      setPos({ bottom, left: rect.left })
    }
    setIsOpen(true)
  }

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
      if (e.key === "Escape") setIsOpen(false)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [isOpen])

  return (
    <>
      {/* Floating card — fixed positioning escapes any overflow:clip ancestor */}
      {isOpen && pos && (
        <div
          ref={panelRef}
          className="fixed z-[300] rounded-xl bg-app-card border border-[var(--border)] shadow-2xl shadow-black/40 backdrop-blur-lg select-none"
          style={{
            bottom: pos.bottom,
            ...(pos.centerX !== undefined
              ? { left: pos.centerX, transform: "translateX(-50%)" }
              : pos.left !== undefined ? { left: pos.left } : { right: pos.right }),
            width,
          }}
        >
          {typeof children === "function"
            ? (children as (close: () => void) => ReactNode)(close)
            : children}
        </div>
      )}

      {/* Toggle button */}
      <div className="relative flex flex-col items-center flex-shrink-0">
        <button
          ref={buttonRef}
          onClick={toggle}
          disabled={disabled}
          title={label}
          aria-label={label}
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
