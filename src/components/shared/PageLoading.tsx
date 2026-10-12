type Props = {
  message: string
  variant?: "detail" | "shelves"
}

/** Keep the page's shape visible while its first request is in flight. */
export function PageLoading({ message, variant = "detail" }: Props) {
  return (
    <div className="space-y-6 px-8 py-6">
      <div role="status" className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent motion-safe:animate-pulse" />
        {message}
      </div>
      <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
        {variant === "detail" ? (
          <>
            <div className="flex items-end gap-6 rounded-xl bg-app-card p-5">
              <div className="h-36 w-36 shrink-0 rounded-lg bg-app-surface" />
              <div className="min-w-0 flex-1 space-y-4 py-1">
                <div className="h-3 w-16 rounded bg-app-surface" />
                <div className="h-8 w-3/4 max-w-md rounded bg-app-surface" />
                <div className="h-3 w-full max-w-xs rounded bg-app-surface" />
                <div className="flex gap-2">
                  <div className="h-9 w-9 rounded-full bg-app-surface" />
                  <div className="h-9 w-9 rounded-full bg-app-surface" />
                </div>
              </div>
            </div>
            <div className="space-y-2">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="flex h-12 items-center gap-4 rounded-md px-3">
                  <div className="h-8 w-8 shrink-0 rounded bg-app-surface" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="h-3 w-2/5 max-w-xs rounded bg-app-surface" />
                    <div className="h-2 w-1/4 max-w-40 rounded bg-app-surface" />
                  </div>
                  <div className="h-3 w-8 rounded bg-app-surface" />
                </div>
              ))}
            </div>
          </>
        ) : (
          Array.from({ length: 2 }, (_, row) => (
            <div key={row} className="space-y-4 overflow-hidden">
              <div className="h-5 w-40 rounded bg-app-surface" />
              <div className="flex gap-3">
                {Array.from({ length: 7 }, (_, index) => (
                  <div key={index} className="w-36 shrink-0 space-y-3 rounded-lg bg-app-card p-3">
                    <div className="aspect-square rounded-md bg-app-surface" />
                    <div className="h-3 w-4/5 rounded bg-app-surface" />
                    <div className="h-2 w-3/5 rounded bg-app-surface" />
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
