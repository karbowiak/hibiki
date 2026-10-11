import { ArtworkImage } from "./shared/ArtworkImage"
interface Props {
  src: string | null
  className?: string
}

/**
 * Renders a blurred, saturated version of an image as an ambient background.
 * The image is scaled up slightly so the blur doesn't reveal the edges.
 * Designed to be used inside a `relative` container as an `absolute` layer.
 */
export function UltraBlur({ src, className = "" }: Props) {
  if (!src) return null
  return (
    <div
      className={`absolute inset-0 overflow-hidden ${className}`}
      aria-hidden
    >
      <ArtworkImage loading="eager"
        src={src}
        alt=""
        className="h-full w-full object-cover"
        style={{
          transform: "scale(1.4)",
          filter: "blur(60px) brightness(0.45) saturate(2.5)",
        }}
      />
    </div>
  )
}
