import { Button } from "./Button"
import { useId } from "react"

export type PageRecoveryProps = {
  title: string
  description?: string
  onRetry?: () => void | Promise<void>
  onOpenSettings?: () => void
  onReturnLibrary?: () => void
  kind?: "error" | "empty"
}

/** Page-local recovery copy must describe the task, never expose service errors. */
export function PageRecovery({
  title,
  description,
  onRetry,
  onOpenSettings,
  onReturnLibrary,
  kind = "error",
}: PageRecoveryProps) {
  const titleId = useId()
  const actionClass =
    "rounded-full border border-(--border) bg-app-surface px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
  return (
    <section
      role={kind === "error" ? "alert" : "region"}
      aria-labelledby={titleId}
      className="my-4 rounded-xl border border-(--border) bg-app-card p-5"
    >
      <h2
        id={titleId}
        className="text-base font-semibold text-(--text-primary)"
      >
        {title}
      </h2>
      {description && (
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-(--text-secondary)">
          {description}
        </p>
      )}
      {(onRetry || onOpenSettings || onReturnLibrary) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {onRetry && (
            <Button
              variant="bare"
              type="button"
              className={actionClass}
              onClick={() => {
                void onRetry()
              }}
            >
              Try again
            </Button>
          )}
          {onOpenSettings && (
            <Button
              variant="bare"
              type="button"
              className={actionClass}
              onClick={onOpenSettings}
            >
              Open Settings
            </Button>
          )}
          {onReturnLibrary && (
            <Button
              variant="bare"
              type="button"
              className={actionClass}
              onClick={onReturnLibrary}
            >
              Return to Library
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
