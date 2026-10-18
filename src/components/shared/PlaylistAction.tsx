import { IconInfoCircle } from "@tabler/icons-react"
import { Button, type ButtonProps } from "./Button"

const icons = {
  play: (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="22"
      height="22"
      fill="currentColor"
    >
      <polygon points="3,2 13,8 3,14" />
    </svg>
  ),
  shuffle: (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
    >
      <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356A2.25 2.25 0 0 1 11.16 4.5h1.949l-1.018 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5zm9.831 8.17l.979 1.167.28.334A3.75 3.75 0 0 0 14.36 14.5h1.64V13h-1.64a2.25 2.25 0 0 1-1.726-.83l-.28-.335-1.733-2.063-.979 1.167 1.18 1.731z" />
    </svg>
  ),
  radio: (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
    >
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
    </svg>
  ),
  sync: null,
  more: (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
    >
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  ),
  info: <IconInfoCircle size={16} aria-hidden="true" />,
}
const labels = {
  play: "Play",
  shuffle: "Shuffle",
  radio: "Radio",
  sync: "Sync",
  more: "More",
  info: "Info",
}

/** Plex's playlist controls define the appearance for every playlist source. */
export function PlaylistAction({
  action,
  children,
  className = "",
  ...props
}: ButtonProps & { action: keyof typeof icons }) {
  return (
    <Button
      size="md"
      variant={action === "play" ? "primary" : "secondary"}
      className={`${action === "play" ? "media-primary" : "media-secondary"} ${className}`}
      {...props}
    >
      {icons[action]}
      {children ?? labels[action]}
    </Button>
  )
}
