import type { KeyboardEvent } from "react"
import type { AppDialogProps } from "../shared/AppDialog"
import { AppDialog } from "../shared/AppDialog"
/** Embedded steps share one top-layer dialog and its write-close lock. */
export function PlaylistSyncFrame({
  embedded = false,
  ...props
}: AppDialogProps & { embedded?: boolean }) {
  if (!embedded) return <AppDialog {...props} />
  return (
    <section aria-label={props.title} className="min-w-0">
      {props.children}
      {props.footer && (
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] pt-4">
          {props.footer}
        </div>
      )}
    </section>
  )
}

/** Roving tab focus stays within the modal and does not reach app hotkeys. */
export function navigateSyncTabs(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
  const buttons = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="tab"]:not(:disabled)'
    ),
  ]
  const index = buttons.indexOf(event.target as HTMLButtonElement)
  if (index < 0 || !buttons.length) return
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
          buttons.length
  event.preventDefault()
  event.stopPropagation()
  buttons[next].click()
  buttons[next].focus()
}
