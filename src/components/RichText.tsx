import { openUrl as open } from "@tauri-apps/plugin-opener"
import { isHttpUrl, sanitizePlexHtml } from "../lib/richText"

interface Props {
  html: string
  className?: string
}

/**
 * Renders Plex description HTML (links, bold, etc.) safely.
 * - Sanitizes malformed / truncated HTML before rendering.
 * - Links open in the system default browser, not inside the app.
 * - Text is selectable (overrides the global select-none).
 */
export function RichText({ html, className = "" }: Props) {
  const clean = sanitizePlexHtml(html)

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest("a")
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute("href")
    if (href && isHttpUrl(href)) void open(href).catch(() => {})
  }

  return (
    <div
      className={`select-text [&_a:hover]:text-accent [&_a]:text-white [&_a]:underline [&_a]:transition-colors ${className}`}
      dangerouslySetInnerHTML={{ __html: clean }}
      onClick={handleClick}
    />
  )
}
