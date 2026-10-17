import { IconAlertTriangle } from "@tabler/icons-react"

export function SyncReviewIndicator() {
  return (
    <IconAlertTriangle
      data-sync-review
      aria-hidden="true"
      size={16}
      className="shrink-0 text-amber-700 dark:text-amber-400"
    />
  )
}
