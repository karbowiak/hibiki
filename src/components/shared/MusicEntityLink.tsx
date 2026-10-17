import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type MouseEvent } from "react"
import { Link, useLocation } from "wouter"
import { musicEntityHref, resolveMusicEntity, captureMusicLinkOwner, beginMusicLinkNavigation, isMusicLinkNavigation, type MusicEntityRef } from "../../lib/musicLinks"
import { useNotificationCenterStore } from "../../stores/notificationCenterStore"

/** Shared Plex-first navigation for provider IDs and metadata-only YTM credits. */
export function MusicEntityLink({ entity, children, className = "", style, title, onNavigate }: {
  entity: MusicEntityRef | null
  children: ReactNode
  className?: string
  style?: CSSProperties
  title?: string
  onNavigate?: () => void
}) {
  const [location, navigate] = useLocation()
  const latestLocation = useRef(location)
  latestLocation.current = location
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [busy, setBusy] = useState(false)
  if (!entity) return <span className={className} style={style}>{children}</span>
  const href = musicEntityHref(entity.kind, entity.id)
  const direct = entity.id && !entity.id.startsWith("ytmusic:")
  const open = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation()
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    if (busy) { event.preventDefault(); return }
    const request = beginMusicLinkNavigation()
    if (direct) { onNavigate?.(); return }
    event.preventDefault()
    const owns = captureMusicLinkOwner()
    setBusy(true)
    void resolveMusicEntity(entity).then(target => {
      if (!mounted.current || !owns() || !isMusicLinkNavigation(request) || latestLocation.current !== location) return
      if (!target) throw Error(`No matching ${entity.kind} was found. Try again after refreshing the page.`)
      navigate(target)
      onNavigate?.()
    }).catch(error => {
      if (!mounted.current || !owns() || !isMusicLinkNavigation(request) || latestLocation.current !== location) return
      useNotificationCenterStore.getState().notify({ id: `music.link.${entity.kind}`, title: `Could not open ${entity.kind}`,
        message: error instanceof Error ? error.message : "Please try again.", severity: "error" })
    }).finally(() => { if (mounted.current) setBusy(false) })
  }
  const props = { className: `${className} ${busy ? "cursor-progress" : ""} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`,
    style, title: title ?? entity.name, "aria-busy": busy,
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
    onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
    onDoubleClick: (event: MouseEvent) => event.stopPropagation(), onClick: open }
  return href ? <Link href={href} {...props}>{children}</Link>
    : <button type="button" {...props}>{children}</button>
}
