import { useEffect, useRef, useState, type RefObject } from "react"
import { ArtworkImage } from "./ArtworkImage"
import { useScrollContainer } from "../../lib/scrollContainer"
import { artworkPlacement } from "../../lib/artworkLayout"

type Band = {
  left: number
  top: number
  width: number
  height: number
  heroTop: number
  heroHeight: number
}
/** Pinned sharp band and an identically scaled lower-image wash, clipped to the content column. */
export function MediaBackdrop({
  src,
  heroRef,
  position = "50% 50%",
  onFailure,
}: {
  src: string | null
  heroRef: RefObject<HTMLDivElement | null>
  position?: string
  onFailure?: (url: string) => void
}) {
  const scrollerRef = useScrollContainer()
  const [band, setBand] = useState<Band | null>(null)
  const [image, setImage] = useState<{
    src: string
    width: number
    height: number
  } | null>(null)
  const sharpRef = useRef<HTMLDivElement>(null)
  const currentSource = useRef(src)
  currentSource.current = src
  // Sibling hero and parent scroll refs are attached after this child's layout
  // effect; the passive phase sees the complete committed content column.
  useEffect(() => {
    const hero = heroRef.current,
      scroller = scrollerRef?.current
    if (!hero || !scroller) return
    const clip = () => {
      const element = sharpRef.current
      if (!element) return
      const h = hero.clientHeight,
        scroll = Math.max(0, scroller.scrollTop)
      element.style.clipPath = `inset(0 0 ${Math.min(h, scroll)}px 0)`
      element.style.visibility = scroll >= h ? "hidden" : "visible"
    }
    const measure = () => {
      const area = scroller.getBoundingClientRect(),
        rect = hero.getBoundingClientRect()
      const next = {
        left: area.left,
        top: area.top,
        width: area.width,
        height: area.height,
        heroTop: rect.top + scroller.scrollTop,
        heroHeight: hero.clientHeight,
      }
      setBand((previous) =>
        previous &&
        Object.keys(next).every(
          (key) => previous[key as keyof Band] === next[key as keyof Band]
        )
          ? previous
          : next
      )
      clip()
    }
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null
    observer?.observe(hero)
    observer?.observe(scroller)
    window.addEventListener("resize", measure)
    // A sidebar resize can move the content column without changing hero size.
    window.addEventListener("resizable-change", measure)
    scroller.addEventListener("scroll", clip, { passive: true })
    measure()
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", measure)
      window.removeEventListener("resizable-change", measure)
      scroller.removeEventListener("scroll", clip)
    }
  }, [heroRef, scrollerRef, src])
  if (!src) return null
  const focal = position.split(/\s+/).map((value) => parseFloat(value) / 100)
  const dimensions = image?.src === src ? image : null
  const placement =
    band && dimensions
      ? artworkPlacement(
          band.width,
          band.heroHeight,
          dimensions.width,
          dimensions.height,
          focal[0],
          focal[1]
        )
      : null
  const top = band && placement ? band.heroTop - band.top + placement.top : 0
  const picture = placement
    ? {
        position: "absolute" as const,
        left: placement.left,
        top,
        width: placement.width,
        height: placement.height,
        maxWidth: "none",
      }
    : {
        width: "100%",
        height: "100%",
        objectFit: "cover" as const,
        objectPosition: position,
      }
  return (
    <div className="media-backdrop" aria-hidden="true">
      <div
        className="media-backdrop__ambient"
        style={
          band
            ? {
                position: "fixed",
                left: band.left,
                top: band.top,
                width: band.width,
                height: band.height,
              }
            : undefined
        }
      >
        <div className="media-backdrop__pixels">
          <ArtworkImage
            src={src}
            alt=""
            loading="eager"
            style={picture}
            onFailure={onFailure}
            onLoad={(event) => {
              if (currentSource.current === src)
                setImage({
                  src,
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
            }}
          />
          {placement && band && top + placement.height < band.height && (
            <ArtworkImage
              src={src}
              alt=""
              loading="eager"
              className="media-backdrop__mirror"
              style={{
                position: "absolute",
                left: placement.left,
                top: top + placement.height,
                width: placement.width,
                height: placement.height,
                maxWidth: "none",
                transform: "scaleY(-1)",
              }}
            />
          )}
        </div>
        <div className="media-backdrop__wash" />
      </div>
      <div
        ref={sharpRef}
        className="media-backdrop__sharp"
        style={
          band
            ? {
                position: "fixed",
                left: band.left,
                top: band.heroTop,
                width: band.width,
                height: band.heroHeight,
              }
            : undefined
        }
      >
        <ArtworkImage
          src={src}
          alt=""
          loading="eager"
          onFailure={onFailure}
          className="media-backdrop__sharp-image"
          style={{ objectPosition: position }}
        />
        <div className="media-backdrop__grade" />
      </div>
    </div>
  )
}
