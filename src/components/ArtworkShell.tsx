import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react"
import { useLocation } from "wouter"
import { useAmbientArtwork } from "../hooks/useAmbientArtwork"
import type { AmbientArtwork } from "../stores/ambientArtworkStore"
import { useArtworkTone } from "../hooks/useArtworkTone"
import { useArtworkAppearanceStore } from "../stores/artworkAppearanceStore"
import { useProviderStore } from "../stores/providerStore"
import { useCustomColorStore } from "../stores/customColorStore"
import { getTheme, subscribeTheme } from "../stores/themeStore"
import { ArtworkPaletteContext } from "../lib/artworkPaletteContext"
import { artworkUiPalette } from "../lib/artworkUiPalette"
import { artworkPlacement } from "../lib/artworkLayout"
import { ArtworkImage } from "./shared/ArtworkImage"

type ReadyArtwork = {
  artwork: AmbientArtwork
  width: number
  height: number
  provider: ReturnType<typeof useProviderStore.getState>["provider"]
  scope: string | undefined
}
/** A single image owner and palette for the complete desktop window. */
export function ArtworkShell({ children }: { children: ReactNode }) {
  const [route] = useLocation()
  const { artwork, onFailure } = useAmbientArtwork(route)
  const provider = useProviderStore((state) => state.provider),
    scope = provider?.cacheScope
  const enabled = useArtworkAppearanceStore(
    (state) => state.backgroundArtworkEnabled
  )
  const opacity = useArtworkAppearanceStore((state) => state.interfaceOpacity)
  const colorsEnabled = useArtworkAppearanceStore(
    (state) => state.artworkColorsEnabled
  )
  const customColors = useCustomColorStore((state) => state.overrides)
  const customEnabled = useCustomColorStore((state) => state.enabled)
  const theme = useSyncExternalStore(subscribeTheme, getTheme)
  const [display, setDisplay] = useState<{
    current: ReadyArtwork | null
    previous: ReadyArtwork | null
  }>({ current: null, previous: null })
  const currentRequest = useRef({ artwork, provider, scope, enabled })
  currentRequest.current = { artwork, provider, scope, enabled }
  const ready =
    enabled &&
    display.current?.provider === provider &&
    display.current.scope === scope
      ? display.current
      : null
  const previous =
    enabled &&
    display.previous?.provider === provider &&
    display.previous.scope === scope
      ? display.previous
      : null
  // Geometry changes with scrolling; they do not reload pixels or restart a fade.
  const frame =
    ready && artwork?.src === ready.artwork.src ? { ...ready, artwork } : ready
  const tone = useArtworkTone(frame?.artwork.src ?? null)
  const background =
    typeof document === "undefined"
      ? "#121212"
      : getComputedStyle(document.documentElement)
          .getPropertyValue("--bg-base")
          .trim()
  const palette = artworkUiPalette(tone, background)
  const revision = JSON.stringify([
    frame?.artwork.src,
    palette,
    theme,
    customEnabled,
    customColors,
    colorsEnabled,
  ])
  useEffect(() => {
    if (!previous) return
    const timer = setTimeout(
      () =>
        setDisplay((state) =>
          state.previous === previous ? { ...state, previous: null } : state
        ),
      650
    )
    return () => clearTimeout(timer)
  }, [previous])
  return (
    <ArtworkPaletteContext.Provider value={revision}>
      <div
        className="app-artwork-shell"
        data-artwork-background={frame ? "ready" : "empty"}
        data-artwork-colors={palette ? "on" : "off"}
        style={{ ...palette, "--interface-opacity": opacity } as CSSProperties}
      >
        <div className="app-artwork-background" aria-hidden="true">
          {previous && (
            <BackdropFrame
              key={`previous-${previous.artwork.src}`}
              ready={previous}
              retiring
            />
          )}
          {frame && <BackdropFrame key={frame.artwork.src} ready={frame} />}
          {enabled && artwork && artwork.src !== ready?.artwork.src && (
            <ArtworkImage
              key={artwork.src}
              src={artwork.src}
              alt=""
              loading="eager"
              className="app-artwork-staging"
              onFailure={(src) => {
                const current = currentRequest.current
                if (
                  current.enabled &&
                  current.artwork?.src === src &&
                  current.provider === provider &&
                  current.scope === scope &&
                  useProviderStore.getState().provider === provider &&
                  provider?.cacheScope === scope
                )
                  onFailure(src)
              }}
              onLoad={(event) => {
                const current = currentRequest.current
                if (
                  !current.enabled ||
                  current.provider !== provider ||
                  current.scope !== scope ||
                  current.artwork?.src !== artwork.src ||
                  useProviderStore.getState().provider !== provider ||
                  provider?.cacheScope !== scope
                )
                  return
                const next = {
                  artwork: current.artwork,
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                  provider,
                  scope,
                }
                setDisplay((state) => ({
                  current: next,
                  previous:
                    state.current?.provider === provider &&
                    state.current.scope === scope
                      ? state.current
                      : null,
                }))
              }}
            />
          )}
        </div>
        <div className="app-artwork-content">{children}</div>
      </div>
    </ArtworkPaletteContext.Provider>
  )
}

function BackdropFrame({
  ready,
  retiring = false,
}: {
  ready: ReadyArtwork
  retiring?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0, top: 0 })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setSize((previous) =>
        previous.width === rect.width &&
        previous.height === rect.height &&
        previous.top === rect.top
          ? previous
          : { width: rect.width, height: rect.height, top: rect.top }
      )
    }
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null
    observer?.observe(element)
    window.addEventListener("resize", measure)
    measure()
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [])
  const { artwork } = ready
  const align = artwork.align
  const fullHeroHeight = align
    ? Math.max(1, align.heroTop - size.top + align.heroH)
    : size.height
  const [x, y] = artwork.position
    .split(/\s+/)
    .map((value) => parseFloat(value) / 100)
  const placement = artworkPlacement(
    size.width,
    fullHeroHeight,
    ready.width,
    ready.height,
    x,
    y
  )
  const picture = placement
    ? { position: "absolute" as const, ...placement, maxWidth: "none" }
    : { width: "100%", height: "100%", objectFit: "cover" as const }
  const sharpBottom = align
    ? Math.max(0, Math.min(size.height, fullHeroHeight - align.scrollTop))
    : 0
  return (
    <div
      ref={ref}
      className={`app-artwork-frame ${retiring ? "app-artwork-frame--retiring" : ""}`}
      data-artwork-origin={artwork.origin}
    >
      <div className="app-artwork-ambient">
        <div className="app-artwork-pixels">
          <ArtworkImage
            src={artwork.src}
            alt=""
            loading="eager"
            style={picture}
          />
          {placement && placement.top + placement.height < size.height && (
            <ArtworkImage
              src={artwork.src}
              alt=""
              loading="eager"
              style={{
                ...picture,
                top: placement.top + placement.height,
                transform: "scaleY(-1)",
              }}
            />
          )}
        </div>
        <div className="app-artwork-wash" />
      </div>
      {align && (
        <div
          className="app-artwork-sharp"
          style={{
            height: fullHeroHeight,
            clipPath: `inset(0 0 ${Math.max(0, fullHeroHeight - sharpBottom)}px 0)`,
            visibility: sharpBottom > 0 ? "visible" : "hidden",
          }}
        >
          <ArtworkImage
            src={artwork.src}
            alt=""
            loading="eager"
            style={picture}
          />
          <div className="app-artwork-grade" />
        </div>
      )}
    </div>
  )
}
