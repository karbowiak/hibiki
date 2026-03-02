/**
 * Priority-aware wrapper around MediaCard.
 *
 * Resolves the best available image for an artist or album based on the current
 * metadata source priority order before passing it to MediaCard.
 *
 * Two private sub-components (ArtistVariant / AlbumVariant) ensure each hook is
 * called unconditionally — satisfying the "hooks can't be conditional" rule.
 */

import { MediaCard } from "./MediaCard"
import { useArtistImage, useAlbumImage } from "../hooks/useMediaImage"

interface PriorityMediaCardProps {
  title: string
  desc: string
  /** Base Plex thumbnail URL. Also used as the fallback when external sources have no image. */
  thumb: string | null
  isArtist?: boolean
  scrollItem?: boolean
  large?: boolean
  href?: string
  onClick?: () => void
  prefetch?: () => void
  onPlay?: (e: React.MouseEvent) => void
  onContextMenu?: (e: React.MouseEvent) => void
  /** Artist name used to look up external metadata. */
  artistName?: string | null
  /** Album name used to look up external metadata (only relevant when isArtist=false). */
  albumName?: string | null
}

function ArtistVariant({ artistName, thumb, ...rest }: PriorityMediaCardProps & { isArtist: true }) {
  const resolved = useArtistImage(artistName ?? null, thumb)
  return <MediaCard {...rest} thumb={resolved} isArtist />
}

function AlbumVariant({ artistName, albumName, thumb, ...rest }: PriorityMediaCardProps) {
  const resolved = useAlbumImage(artistName ?? null, albumName ?? null, thumb)
  return <MediaCard {...rest} thumb={resolved} isArtist={false} />
}

export function PriorityMediaCard({ isArtist, ...props }: PriorityMediaCardProps) {
  if (isArtist) return <ArtistVariant {...props} isArtist />
  return <AlbumVariant {...props} />
}
