import { open } from "@tauri-apps/plugin-shell"

interface Props {
  html: string
  className?: string
}

/**
 * Sanitize Plex description HTML before rendering.
 *
 * Plex descriptions can contain:
 * - Truncated / unclosed <a> tags (e.g. `<a href="http://facebook.com` with no closing `>`)
 * - Newlines mixed into the text
 * - Trailing separators (|) left behind by stripped links
 *
 * Strategy: parse with DOMParser (which handles malformed HTML gracefully),
 * then reconstruct clean HTML by walking the tree and only keeping elements
 * that are complete and safe. An <a> is only kept when it has both an href
 * and visible inner text — incomplete ones produce empty text nodes and are
 * dropped.
 */
function sanitizePlexHtml(raw: string): string {
  const normalized = raw.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim()

  const doc = new DOMParser().parseFromString(`<div>${normalized}</div>`, "text/html")
  const root = doc.body.querySelector("div")
  if (!root) return normalized

  function walk(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
    if (node.nodeType !== Node.ELEMENT_NODE) return ""

    const el = node as Element
    const tag = el.tagName.toLowerCase()
    const children = Array.from(el.childNodes).map(walk).join("")

    if (tag === "a") {
      const href = el.getAttribute("href") ?? ""
      const text = children.trim()
      // Drop links that are missing either an href or visible text
      // (catches truncated <a href="..." tags that had no closing >)
      if (href && text) return `<a href="${href}">${text}</a>`
      return text
    }

    if (tag === "br") return "<br>"
    if (["b", "i", "em", "strong"].includes(tag)) return `<${tag}>${children}</${tag}>`

    // div, span, p, unknown — pass through children only
    return children
  }

  return walk(root)
    // Remove trailing pipe separators left by stripped links (e.g. "Instagram | ")
    .replace(/(\s*\|\s*)+$/, "")
    .trim()
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
    if (href) void open(href)
  }

  return (
    <div
      className={`select-text [&_a]:text-white [&_a]:underline [&_a:hover]:text-accent [&_a]:transition-colors ${className}`}
      dangerouslySetInnerHTML={{ __html: clean }}
      onClick={handleClick}
    />
  )
}
