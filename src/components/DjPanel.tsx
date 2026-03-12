import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores"
import { DJ_MODES, type DjMode } from "../stores/playerStore"

interface Props {
  onClose: () => void
}

export default function DjPanel({ onClose }: Props) {
  const { djMode, setDjMode } = usePlayerStore(
    useShallow(s => ({ djMode: s.djMode, setDjMode: s.setDjMode })),
  )

  return (
    <div className="py-2">
      <div className="px-4 pb-2 text-[0.625rem] font-semibold uppercase tracking-widest text-[color:var(--text-muted)]">
        Guest DJ
      </div>
      {DJ_MODES.map(dj => {
        const active = djMode === dj.key
        return (
          <button
            key={dj.key}
            onClick={() => {
              setDjMode(active ? null : (dj.key as DjMode))
              onClose()
            }}
            className={`w-full text-left px-4 py-2.5 transition-colors ${
              active ? "bg-[var(--accent-tint)]" : "hover:bg-[var(--accent-tint-hover)]"
            }`}
          >
            <div
              className={`flex items-center gap-2 text-sm font-medium ${
                active ? "text-accent" : "text-[color:var(--text-primary)]"
              }`}
            >
              {active ? (
                <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" className="flex-shrink-0">
                  <path d="M13.78 3.22a.75.75 0 0 1 0 1.06l-8 8a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06L5.25 10.69l7.47-7.47a.75.75 0 0 1 1.06 0z" />
                </svg>
              ) : (
                <span className="w-[10px] flex-shrink-0" />
              )}
              {dj.name}
            </div>
            <div className="text-xs text-[color:var(--text-muted)] pl-[18px] mt-0.5">{dj.desc}</div>
          </button>
        )
      })}
      {djMode && (
        <div className="border-t border-[var(--border)] mt-1 pt-1">
          <button
            onClick={() => {
              setDjMode(null)
              onClose()
            }}
            className="w-full text-left px-4 py-1.5 text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors"
          >
            Turn off Guest DJ
          </button>
        </div>
      )}
    </div>
  )
}
