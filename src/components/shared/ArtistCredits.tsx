import { Fragment } from "react"
import type { MusicAlbum, MusicTrack, MusicArtistCredit } from "../../types/music"
import { itemArtistCredits } from "../../lib/artistCredits"
import { MusicEntityLink } from "./MusicEntityLink"

export function ArtistCredits({ item, className = "", onNavigate }: {
  item: MusicTrack | MusicAlbum
  className?: string
  onNavigate?: () => void
}) {
  return <ArtistCreditLinks credits={itemArtistCredits(item)} className={className} onNavigate={onNavigate} />
}

export function ArtistCreditLinks({ credits, className = "", onNavigate }: {
  credits: MusicArtistCredit[]
  className?: string
  onNavigate?: () => void
}) {
  return <>{credits.map((credit, index) => <Fragment key={credit.id || credit.name}>
    {index > 0 && <span>, </span>}
    <MusicEntityLink entity={{ kind: "artist", id: credit.id, name: credit.name }} className={className} onNavigate={onNavigate}>
      {credit.name}
    </MusicEntityLink>
  </Fragment>)}</>
}
