import { Button } from "./Button"
import { useModalLifecycle } from "../../hooks/useModalLifecycle"
import {
  useId,
  useRef,
  type ReactNode,
  type CSSProperties,
} from "react"
import { createPortal } from "react-dom"
import { IconX } from "@tabler/icons-react"

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
  useModalLifecycle(dialog, { onClose, canClose, initialFocus: close })
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
        if (canClose) onClose()
      }}
      onKeyDown={(event) => {
        // Let child controls handle arrows before containing app playback keys.
        if (
          (event.target as Element)?.closest?.("dialog") === event.currentTarget
        )
          event.stopPropagation()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && canClose) onClose()
      }}
      className={`app-overlay-surface fixed inset-0 m-auto max-h-[min(90dvh,900px)] w-[calc(100%-2rem)] overflow-hidden rounded-2xl border border-(--border) bg-app-card p-0 text-(--text-primary) shadow-2xl backdrop:bg-black/65 ${className}`}
    >
      <div
        className="flex max-h-[min(90dvh,900px)] flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <header
          className={`app-dialog-header relative flex shrink-0 items-start justify-between gap-4 border-b border-(--border) p-5 ${headerBackdrop ? "app-dialog-header--artwork" : ""}`}
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
              <h2 id={`${id}-title`} className="wrap-break-word text-xl font-semibold">
                {title}
              </h2>
              {description && (
                <p
                  id={`${id}-description`}
                  className="mt-1 text-sm text-(--text-secondary)"
                >
                  {description}
                </p>
              )}
            </div>
          </div>
          <Button
            variant="bare"
            ref={close}
            type="button"
            aria-label={`Close ${title}`}
            disabled={!canClose}
            onClick={onClose}
            className="app-dialog-close player-panel-icon relative disabled:opacity-40"
          >
            <IconX size={20} aria-hidden="true" />
          </Button>
        </header>
        <div className={bodyClassName}>{children}</div>
        {footer && (
          <footer className="shrink-0 border-t border-(--border) p-4">
            {footer}
          </footer>
        )}
      </div>
    </dialog>,
    document.body
  )
}
