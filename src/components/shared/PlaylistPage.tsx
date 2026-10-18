import { useRef, type ReactNode, type ComponentProps } from "react"
import { PlaylistHero } from "./PlaylistHero"
import { AmbientHeroBackdrop } from "./MediaBackdrop"
import { PlaylistAction } from "./PlaylistAction"
import { TrackTable, type TrackTableProps } from "./TrackTable"
import { RichText } from "../RichText"
import { formatTotalMs } from "../../lib/formatters"
import type { MusicPlaylist } from "../../types/music"

type Action = ComponentProps<typeof PlaylistAction>["action"]
/** Controllers own data, permissions, paging and provider operations. The view
 * owns the common hierarchy, action order, overview and table interactions. */
export interface PlaylistPageModel {
  playlist: MusicPlaylist
  source: ReactNode
  countPartial?: boolean
  runtimePartial?: boolean
  actions: Partial<
    Record<Action, Omit<ComponentProps<typeof PlaylistAction>, "action">>
  >
  table: TrackTableProps
}
export function PlaylistPage({
  model,
  dialogs,
  overview,
  notice,
  after,
  dropTarget,
  empty,
}: {
  model: PlaylistPageModel
  dialogs?: ReactNode
  overview?: ReactNode
  notice?: ReactNode
  after?: ReactNode
  dropTarget?: string
  empty?: ReactNode
}) {
  const heroRef = useRef<HTMLDivElement>(null)
  const { playlist, table } = model
  return (
    <div
      className="media-detail-page playlist-detail-page pb-12"
      data-playlist-drop-target={dropTarget}
    >
      {dialogs}
      <AmbientHeroBackdrop heroRef={heroRef} />
      <PlaylistHero
        heroRef={heroRef}
        artwork={playlist.thumbUrl}
        title={playlist.title}
        byline={
          <p className="mt-2 flex items-center gap-2 text-sm text-(--text-secondary)">
            {model.source}
          </p>
        }
        description={
          playlist.summary && (
            <RichText
              html={playlist.summary}
              className="mt-2 line-clamp-2 max-w-xl text-sm text-(--text-secondary)"
            />
          )
        }
      >
        {(
          ["play", "shuffle", "radio", "sync", "link", "download"] as const
        ).map((action) => {
          const capability = model.actions[action]
          return (
            capability && (
              <PlaylistAction key={action} action={action} {...capability} />
            )
          )
        })}
        <span className="inline-flex items-center gap-3">
          {(["more", "info"] as const).map(
            (action) =>
              model.actions[action] && (
                <PlaylistAction
                  key={action}
                  action={action}
                  {...model.actions[action]}
                />
              )
          )}
        </span>
      </PlaylistHero>
      <dl
        className="media-ledger playlist-overview"
        aria-label="Playlist overview"
      >
        <div>
          <dt>Songs</dt>
          <dd>
            {playlist.trackCount.toLocaleString()}
            {model.countPartial ? "+" : ""}
          </dd>
        </div>
        {!!playlist.duration && (
          <div>
            <dt>Runtime{model.runtimePartial ? " so far" : ""}</dt>
            <dd>{formatTotalMs(playlist.duration)}</dd>
          </div>
        )}
        {overview}
      </dl>
      {notice}
      {empty ?? <TrackTable {...table} />}
      {after}
    </div>
  )
}
