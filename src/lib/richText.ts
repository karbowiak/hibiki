import createDOMPurify from "dompurify"

let purifier: ReturnType<typeof createDOMPurify> | undefined

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

/** Preserve description formatting without rebuilding HTML from decoded text. */
export function sanitizePlexHtml(raw: string): string {
  const normalized = raw.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim()
  purifier ??= createDOMPurify(window)
  return purifier
    .sanitize(normalized, {
      ALLOWED_TAGS: ["a", "br", "b", "i", "em", "strong"],
      ALLOWED_ATTR: ["href"],
      ALLOW_DATA_ATTR: false,
      ALLOWED_URI_REGEXP: /^https?:\/\//i,
    })
    .replace(/(\s*\|\s*)+$/, "")
    .trim()
}
