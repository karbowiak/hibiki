/** Wouter already unescapes its matched pathname. Decode the original route
 * segment once so literal percent sequences remain part of the library name. */
export function libraryRouteSegment(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null
  const encoded = path.slice(prefix.length)
  if (!encoded || encoded.includes("/") || encoded.length > 64 * 1024) return null
  try {
    const decoded = decodeURIComponent(encoded)
    return decoded && !/[\u0000-\u001f\u007f]/.test(decoded) ? decoded : null
  } catch { return null }
}
