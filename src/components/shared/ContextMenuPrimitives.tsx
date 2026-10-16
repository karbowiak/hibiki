import type { ReactNode } from "react"

export function MenuItem({
  icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon?: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent enabled:hover:bg-hl-menu disabled:cursor-default disabled:opacity-40 ${danger ? "text-red-400" : "text-[var(--text-primary)]"}`}
    >
      {icon && <span className="h-4 w-4 flex-shrink-0 opacity-70">{icon}</span>}
      {label}
    </button>
  )
}

export function MenuDivider() {
  return <div className="my-1 border-t border-[var(--border)]" />
}

export function MenuSectionLabel({ label }: { label: string }) {
  return (
    <div className="px-3 pb-0.5 pt-2 text-xs font-semibold text-[var(--text-secondary)]">
      {label}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SVG icons
// ---------------------------------------------------------------------------

export const IconPlay = (
  <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
    <polygon points="3,2 13,8 3,14" />
  </svg>
)
export const IconNext = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M6 18l8.5-6L6 6v12zm2-8.14L11.03 12 8 14.14V9.86zM16 6h2v12h-2z" />
  </svg>
)
export const IconQueue = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" />
  </svg>
)
export const IconNewPlaylist = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm11.5-4.5v3h-3v2h3v3h2v-3h3v-2h-3v-3h-2z" />
  </svg>
)
export const IconRadio = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M20 10.54V5l-7.56 2.84-5.16 1.94L5 10H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2v-7.46l-3-2zm1 9.46H3v-8h18v8zM9 14.5c0 1.38-1.12 2.5-2.5 2.5S4 15.88 4 14.5 5.12 12 6.5 12 9 13.12 9 14.5z" />
  </svg>
)
export const IconShare = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" />
  </svg>
)
export const IconArtist = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5.33 0-8 2.67-8 4v1h16v-1c0-1.33-2.67-4-8-4z" />
  </svg>
)
export const IconAlbum = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z" />
  </svg>
)
export const IconPlaylist = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM3 16h7v-2H3v2z" />
  </svg>
)
export const IconBug = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M20 8h-2.81a5.985 5.985 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17a5.947 5.947 0 0 0-2.84 0L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81A6.008 6.008 0 0 0 12 22a6.008 6.008 0 0 0 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z" />
  </svg>
)
export const IconShuffle = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />
  </svg>
)
export const IconDelete = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
  </svg>
)
export const IconEdit = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
  </svg>
)
export const IconRemove = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M7 11v2h10v-2H7zm5-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" />
  </svg>
)
