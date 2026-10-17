import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import "../styles/hoverInformation.css"

export const HOVER_INFORMATION_DELAY = 180

/** One delegated tooltip for existing title/data-tooltip controls, including portals. */
export function HoverInformation() {
  const id = useId(),
    panel = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ target: HTMLElement; text: string } | null>(
    null
  )
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const dismiss = useRef(() => {})
  useEffect(() => {
    let active: {
      target: HTMLElement
      title: string | null
      description: string | null
      labelAdded: boolean
    } | null = null
    let show: ReturnType<typeof setTimeout> | undefined,
      hide: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      clearTimeout(show)
      clearTimeout(hide)
      if (active) {
        if (active.title !== null && !active.target.hasAttribute("title"))
          active.target.setAttribute("title", active.title)
        const described = active.target
          .getAttribute("aria-describedby")
          ?.split(/\s+/)
          .filter((value) => value !== id)
          .join(" ")
        if (described) active.target.setAttribute("aria-describedby", described)
        else if (active.description === null)
          active.target.removeAttribute("aria-describedby")
        if (active.labelAdded) active.target.removeAttribute("aria-label")
      }
      active = null
      setTip(null)
    }
    dismiss.current = clear
    const enter = (event: Event) => {
      if ((event as PointerEvent).pointerType === "touch") return
      const origin = event.target instanceof Element ? event.target : null
      if (!origin || origin.closest("[data-hover-information]")) {
        clearTimeout(hide)
        return
      }
      if (active?.target.contains(origin)) {
        clearTimeout(hide)
        return
      }
      const target = origin.closest<HTMLElement>("[data-tooltip], [title]")
      if (!target || target.closest("[inert], [data-tooltip-disabled]")) {
        clear()
        return
      }
      const text =
        target.getAttribute("data-tooltip") || target.getAttribute("title")
      if (!text?.trim()) {
        clear()
        return
      }
      clear()
      const title = target.getAttribute("title"),
        description = target.getAttribute("aria-describedby")
      // Suppress the slow native bubble while retaining icon-only accessible names.
      const labelAdded =
        !target.getAttribute("aria-label") &&
        !target.getAttribute("aria-labelledby") &&
        !target.textContent?.trim() &&
        target.matches("button,a,input,[role=button]")
      if (labelAdded) target.setAttribute("aria-label", text)
      target.removeAttribute("title")
      active = { target, title, description, labelAdded }
      show = setTimeout(
        () => {
          if (active?.target !== target || !target.isConnected) return
          target.setAttribute(
            "aria-describedby",
            [description, id].filter(Boolean).join(" ")
          )
          setTip({ target, text })
        },
        event.type === "focusin" ? 0 : HOVER_INFORMATION_DELAY
      )
    }
    const leave = (event: Event) => {
      const related = (event as PointerEvent | FocusEvent)
        .relatedTarget as Node | null
      if (
        related &&
        (active?.target.contains(related) || panel.current?.contains(related))
      )
        return
      clearTimeout(hide)
      hide = setTimeout(clear, 100)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (panel.current) {
          event.preventDefault()
          event.stopPropagation()
        }
        clear()
      }
    }
    const down = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !panel.current?.contains(event.target)
      )
        clear()
    }
    document.addEventListener("pointerover", enter)
    document.addEventListener("pointerout", leave)
    document.addEventListener("focusin", enter)
    document.addEventListener("focusout", leave)
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("keydown", key, true)
    window.addEventListener("scroll", clear, true)
    window.addEventListener("resize", clear)
    return () => {
      clear()
      document.removeEventListener("pointerover", enter)
      document.removeEventListener("pointerout", leave)
      document.removeEventListener("focusin", enter)
      document.removeEventListener("focusout", leave)
      document.removeEventListener("pointerdown", down, true)
      document.removeEventListener("keydown", key, true)
      window.removeEventListener("scroll", clear, true)
      window.removeEventListener("resize", clear)
    }
  }, [id])
  useLayoutEffect(() => {
    if (!tip || !panel.current) return
    const element = panel.current
    element.showPopover?.()
    const anchor = tip.target.getBoundingClientRect(),
      bounds = element.getBoundingClientRect()
    setPosition({
      left: Math.max(
        8,
        Math.min(
          window.innerWidth - bounds.width - 8,
          anchor.left + (anchor.width - bounds.width) / 2
        )
      ),
      top:
        anchor.bottom + bounds.height + 16 <= window.innerHeight
          ? anchor.bottom + 8
          : Math.max(8, anchor.top - bounds.height - 8),
    })
    return () => {
      element.hidePopover?.()
    }
  }, [tip])
  if (!tip) return null
  return createPortal(
    <div
      ref={panel}
      id={id}
      role="tooltip"
      popover="manual"
      data-hover-information
      className="app-overlay-surface hover-information"
      style={{ left: position.left, top: position.top }}
      onPointerLeave={() => dismiss.current()}
    >
      {tip.text}
    </div>,
    document.body
  )
}
