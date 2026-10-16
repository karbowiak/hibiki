import type { ReactNode } from "react"
import { IconX } from "@tabler/icons-react"

export function PlayerPanelHeader({ title, subtitle, actions, onClose }: {
  title: string
  subtitle?: string | null
  actions?: ReactNode
  onClose: () => void
}) {
  return (
    <header className="player-panel-header">
      <div className="min-w-0">
        <h2 className="player-panel-title">{title}</h2>
        {subtitle && <p className="player-panel-subtitle" title={subtitle}>{subtitle}</p>}
      </div>
      <div className="player-panel-header-actions">
        {actions}
        <button type="button" onClick={onClose} className="player-panel-icon"
          aria-label={`Close ${title}`} title="Close">
          <IconX size={16} aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
