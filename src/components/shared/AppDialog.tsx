import {
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type CSSProperties,
} from "react"
import { createPortal } from "react-dom"

export interface AppDialogProps {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  /** Keep an admitted write or an unretained receipt visible until it settles. */
  canClose?: boolean
  className?: string
  cover?: ReactNode
  headerBackdrop?: ReactNode
  bodyClassName?: string
  style?: CSSProperties
}

/** Native top-layer dialog: overlays stay above the artwork, menus and player. */
export function AppDialog({
  title,
  description,
  children,
  footer,
  onClose,
  canClose = true,
  className = "max-w-3xl",
  cover,
  headerBackdrop,
  bodyClassName = "min-h-0 overflow-y-auto p-5",
  style,
}: AppDialogProps) {
  const id = useId(),
    dialog = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const current = useRef({ onClose, canClose })
  current.current = { onClose, canClose }
  useLayoutEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const native = typeof element.showModal === "function"
    const hidden: {
      node: Element
      aria: string | null
      inert: string | null
    }[] = []
    if (native) element.showModal()
    else {
      element.setAttribute("open", "")
      for (const node of [...document.body.children])
        if (node !== element) {
          hidden.push({
            node,
            aria: node.getAttribute("aria-hidden"),
            inert: node.getAttribute("inert"),
          })
          node.setAttribute("aria-hidden", "true")
          node.setAttribute("inert", "")
        }
    }
    // For a write in progress, focus the dialog instead of its disabled close button.
    if (current.current.canClose) close.current?.focus()
    else element.focus()
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as Element)?.closest?.("dialog") !== element) return
      if (!native && event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        if (current.current.canClose) current.current.onClose()
      }
      if (event.key !== "Tab") return
      const focusable = [
        ...element.querySelectorAll<HTMLElement>(
          "button, a[href], input, textarea, select, [tabindex]"
        ),
      ].filter(
        (node) =>
          !node.hasAttribute("disabled") &&
          node.tabIndex >= 0 &&
          !node.closest("[hidden], [inert]")
      )
      const first = focusable[0],
        last = focusable.at(-1)
      if (!first) {
        event.preventDefault()
        element.focus()
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === element)
      ) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const shortcuts = (event: KeyboardEvent) => {
      if ((event.target as Element)?.closest?.("dialog") !== element) return
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        ["k", "f", "r"].includes(event.key.toLowerCase())
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    element.addEventListener("keydown", keydown)
    window.addEventListener("keydown", shortcuts, true)
    return () => {
      element.removeEventListener("keydown", keydown)
      window.removeEventListener("keydown", shortcuts, true)
      if (native && element.open) element.close()
      for (const { node, aria, inert } of hidden) {
        if (aria === null) node.removeAttribute("aria-hidden")
        else node.setAttribute("aria-hidden", aria)
        if (inert === null) node.removeAttribute("inert")
        else node.setAttribute("inert", inert)
      }
      document.body.style.overflow = overflow
      if (previous?.isConnected && !previous.closest("[inert]"))
        previous.focus({ preventScroll: true })
    }
  }, [])
  return createPortal(
    <dialog
      ref={dialog}
      style={style}
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onCancel={(event) => {
        event.preventDefault()
        if (current.current.canClose) current.current.onClose()
      }}
      onKeyDown={(event) => {
        // Let child controls handle arrows before containing app playback keys.
        if (
          (event.target as Element)?.closest?.("dialog") === event.currentTarget
        )
          event.stopPropagation()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && current.current.canClose)
          current.current.onClose()
      }}
      className={`app-overlay-surface fixed inset-0 m-auto max-h-[min(90dvh,900px)] w-[calc(100%-2rem)] overflow-hidden rounded-2xl border border-[var(--border)] bg-app-card p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/65 ${className}`}
    >
      <div
        className="flex max-h-[min(90dvh,900px)] flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <header
          className={`app-dialog-header relative flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] p-5 ${headerBackdrop ? "app-dialog-header--artwork" : ""}`}
        >
          {headerBackdrop && (
            <div
              className="absolute inset-0 overflow-hidden"
              aria-hidden="true"
            >
              {headerBackdrop}
            </div>
          )}
          <div className="relative flex min-w-0 items-center gap-4">
            {cover}
            <div className="min-w-0">
              <h2 id={`${id}-title`} className="text-xl font-semibold">
                {title}
              </h2>
              {description && (
                <p
                  id={`${id}-description`}
                  className="mt-1 text-sm text-[var(--text-secondary)]"
                >
                  {description}
                </p>
              )}
            </div>
          </div>
          <button
            ref={close}
            type="button"
            aria-label={`Close ${title}`}
            disabled={!canClose}
            onClick={onClose}
            className="app-dialog-close relative shrink-0 rounded-full px-3 py-1.5 text-lg hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
          >
            ×
          </button>
        </header>
        <div className={bodyClassName}>{children}</div>
        {footer && (
          <footer className="shrink-0 border-t border-[var(--border)] p-4">
            {footer}
          </footer>
        )}
      </div>
    </dialog>,
    document.body
  )
}
