import type { WeeklyEditionReceipt } from "../../playlistSync/weekly"
/** Earlier unresolved editions remain inspectable without entering the current edition's plan. */
export function WeeklyEditionHistory({
  receipts,
}: {
  receipts: readonly WeeklyEditionReceipt[]
}) {
  const unresolved = receipts.filter(
    (receipt) => receipt.missingOccurrences?.length
  )
  if (!unresolved.length) return null
  return (
    <section
      aria-label="Earlier weekly editions needing review"
      className="mt-4 rounded-xl border border-[var(--border)] p-3"
    >
      <h4 className="font-medium">Earlier weekly editions</h4>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">
        These songs belong to earlier editions and are kept separately from the
        current sync.
      </p>
      {unresolved.map((receipt) => (
        <details
          key={receipt.edition.playlistId}
          className="mt-3 rounded-lg border border-[var(--border)] p-3"
        >
          <summary className="cursor-pointer text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            {receipt.edition.weekOf
              ? `Week of ${receipt.edition.weekOf}`
              : `Generated ${receipt.edition.createdAt.slice(0, 10)}`}{" "}
            · {receipt.missingOccurrences!.length}{" "}
            {receipt.missingOccurrences!.length === 1
              ? "song needs"
              : "songs need"}{" "}
            review
          </summary>
          {receipt.matchedCount !== undefined &&
            receipt.total !== undefined && (
              <p className="mt-2 text-xs text-[var(--text-secondary)]">
                {receipt.matchedCount} of {receipt.total} songs matched in this
                edition.
              </p>
            )}
          <ol className="mt-2 max-h-52 space-y-1 overflow-auto text-sm">
            {receipt.missingOccurrences!.map((item, index) => (
              <li key={item.occurrenceId}>
                {index + 1}. {item.track.artist || "Unknown artist"} —{" "}
                {item.track.title || "Untitled recording"}
                {item.track.album ? ` · ${item.track.album}` : ""}
              </li>
            ))}
          </ol>
        </details>
      ))}
    </section>
  )
}
