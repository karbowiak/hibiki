import { Button } from "./shared/Button"
import { useEffect, useState } from "react"
import { useDebugPanelStore } from "../stores/debugPanelStore"
import type { MusicTrack, MusicAlbum, MusicArtist, MusicPlaylist } from "../types/music"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr className="border-b border-white/5 last:border-0">
      <td className="py-1.5 pr-4 text-white/40 whitespace-nowrap align-top font-mono text-[11px]">{label}</td>
      <td className="py-1.5 text-white/80 text-right font-mono text-[11px] break-all">{value}</td>
    </tr>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-white/30 mb-2">{title}</h4>
      <table className="w-full text-xs">
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function RawJson({ data }: { data: unknown }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="mb-2">
      <Button
        variant="bare"
        onClick={() => setExpanded(v => !v)}
        className="text-[10px] font-semibold uppercase tracking-wider text-white/30 hover:text-white/50 transition-colors flex items-center gap-1"
      >
        <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"
          className={`transition-transform ${expanded ? "rotate-90" : ""}`}>
          <path d="M6 4l4 4-4 4V4z" />
        </svg>
        Raw JSON
      </Button>
      {expanded && (
        <pre className="mt-2 p-3 rounded bg-white/5 text-[10px] text-white/60 overflow-auto max-h-64 font-mono leading-relaxed">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  )
}

function fmt(v: string | number | null | undefined): string {
  if (v == null) return "—"
  return String(v)
}

// ---------------------------------------------------------------------------
// Per-type content
// ---------------------------------------------------------------------------

function TrackContent({ track }: { track: MusicTrack }) {
  const plex = track._providerData as any
  const media = plex?.media?.[0]
  const part = media?.parts?.[0]
  const streams = part?.streams ?? []

  return (
    <>
      <Section title="IDs">
        <Row label="id" value={fmt(track.id)} />
        <Row label="artistId" value={fmt(track.artistId)} />
        <Row label="albumId" value={fmt(track.albumId)} />
        {track.guid && <Row label="guid" value={fmt(track.guid)} />}
      </Section>

      <Section title="Track Info">
        <Row label="artistName" value={fmt(track.artistName)} />
        <Row label="albumName" value={fmt(track.albumName)} />
        <Row label="thumbUrl" value={fmt(track.thumbUrl)} />
      </Section>

      <Section title="File Info">
        <Row label="file" value={part?.file ?? "---"} />
        <Row label="container" value={fmt(media?.container)} />
        <Row label="codec" value={fmt(track.codec)} />
        <Row label="bitrate" value={track.bitrate ? `${track.bitrate} kbps` : "---"} />
        <Row label="channels" value={fmt(track.channels)} />
        <Row label="bitDepth" value={fmt(track.bitDepth)} />
        <Row label="samplingRate" value={track.samplingRate ? `${track.samplingRate} Hz` : "---"} />
        <Row label="size" value={part?.size ? `${(part.size / 1024 / 1024).toFixed(1)} MB` : "---"} />
      </Section>

      {streams.length > 0 && (
        <Section title="Streams">
          {streams.map((s: any, i: number) => (
            <tr key={i} className="border-b border-white/5 last:border-0">
              <td colSpan={2} className="py-1.5 font-mono text-[11px]">
                <span className="text-white/40">#{i} type={fmt(s.stream_type)} </span>
                <span className="text-white/70">
                  {[
                    s.codec && `codec=${s.codec}`,
                    s.bitrate && `bitrate=${s.bitrate}kbps`,
                    s.channels && `ch=${s.channels}`,
                    s.sampling_rate && `sr=${s.sampling_rate}Hz`,
                    s.bit_depth && `depth=${s.bit_depth}bit`,
                    s.gain != null && `gain=${s.gain.toFixed(2)}dB`,
                    s.loudness != null && `loud=${s.loudness.toFixed(2)}LUFS`,
                    s.peak != null && `peak=${s.peak.toFixed(4)}`,
                  ].filter(Boolean).join("  ")}
                </span>
              </td>
            </tr>
          ))}
        </Section>
      )}

      <Section title="Audio">
        <Row label="gain" value={track.gain != null ? `${track.gain.toFixed(2)} dB` : "---"} />
        <Row label="albumGain" value={track.albumGain != null ? `${track.albumGain.toFixed(2)} dB` : "---"} />
        <Row label="peak" value={track.peak != null ? track.peak.toFixed(4) : "---"} />
        <Row label="loudness" value={track.loudness != null ? `${track.loudness.toFixed(2)} LUFS` : "---"} />
      </Section>

      <Section title="Stats">
        <Row label="playCount" value={fmt(track.playCount)} />
        <Row label="lastPlayedAt" value={fmt(track.lastPlayedAt)} />
        <Row label="addedAt" value={fmt(track.addedAt)} />
        <Row label="userRating" value={fmt(track.userRating)} />
      </Section>

      <RawJson data={track._providerData} />
    </>
  )
}

function AlbumContent({ album }: { album: MusicAlbum }) {
  return (
    <>
      <Section title="IDs">
        <Row label="id" value={fmt(album.id)} />
        <Row label="artistId" value={fmt(album.artistId)} />
        {album.guid && <Row label="guid" value={fmt(album.guid)} />}
      </Section>

      <Section title="Metadata">
        <Row label="artistName" value={fmt(album.artistName)} />
        <Row label="trackCount" value={fmt(album.trackCount)} />
        <Row label="studio" value={fmt(album.studio)} />
        <Row label="year" value={fmt(album.year)} />
        <Row label="format" value={fmt(album.format)} />
        <Row label="thumbUrl" value={fmt(album.thumbUrl)} />
      </Section>

      <Section title="Tags">
        <Row label="genres" value={album.genres.join(", ") || "---"} />
        <Row label="styles" value={album.styles.join(", ") || "---"} />
        <Row label="moods" value={album.moods.join(", ") || "---"} />
        <Row label="labels" value={album.labels.join(", ") || "---"} />
      </Section>

      <Section title="Stats">
        <Row label="addedAt" value={fmt(album.addedAt)} />
        <Row label="userRating" value={fmt(album.userRating)} />
      </Section>

      <RawJson data={album._providerData} />
    </>
  )
}

function ArtistContent({ artist }: { artist: MusicArtist }) {
  return (
    <>
      <Section title="IDs">
        <Row label="id" value={fmt(artist.id)} />
        {artist.guid && <Row label="guid" value={fmt(artist.guid)} />}
      </Section>

      <Section title="Media">
        <Row label="thumbUrl" value={fmt(artist.thumbUrl)} />
        <Row label="artUrl" value={fmt(artist.artUrl)} />
      </Section>

      <Section title="Stats">
        <Row label="addedAt" value={fmt(artist.addedAt)} />
        <Row label="userRating" value={fmt(artist.userRating)} />
      </Section>

      <RawJson data={artist._providerData} />
    </>
  )
}

function PlaylistContent({ playlist }: { playlist: MusicPlaylist }) {
  return (
    <>
      <Section title="IDs">
        <Row label="id" value={fmt(playlist.id)} />
      </Section>

      <Section title="Metadata">
        <Row label="title" value={fmt(playlist.title)} />
        <Row label="smart" value={playlist.smart ? "true" : "false"} />
        <Row label="trackCount" value={fmt(playlist.trackCount)} />
        <Row label="duration" value={playlist.duration ? `${Math.round(playlist.duration / 60000)}m` : "---"} />
        <Row label="thumbUrl" value={fmt(playlist.thumbUrl)} />
      </Section>

      <Section title="Stats">
        <Row label="addedAt" value={fmt(playlist.addedAt)} />
      </Section>

      <RawJson data={playlist._providerData} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DebugPanel() {
  const { open, type, data, close } = useDebugPanelStore()
  const [copied, setCopied] = useState(false)

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") close() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [open, close])

  if (!open || !type || !data) return null

  const title = `Debug — ${type.charAt(0).toUpperCase() + type.slice(1)}`
  const subtitle = (data as MusicTrack | MusicAlbum | MusicArtist | MusicPlaylist).title ?? ""

  function handleCopy() {
    void navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-10000 bg-black/60"
        onClick={close}
      />

      {/* Panel */}
      <div className="fixed inset-0 z-10001 flex items-center justify-center p-6 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-white/10 bg-app-card shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/8 shrink-0">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-accent">{title}</span>
              {subtitle && <span className="ml-2 text-xs text-white/50 truncate">{subtitle}</span>}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={handleCopy}
                className="px-3 py-1 rounded text-xs transition-colors"
              >
                {copied ? "Copied!" : "Copy JSON"}
              </Button>
              <Button
                variant="bare"
                onClick={close}
                className="w-6 h-6 flex items-center justify-center rounded text-white/40 hover:text-white/80 hover:bg-white/8 transition-colors"
                aria-label="Close"
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                  <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
                </svg>
              </Button>
            </div>
          </div>

          {/* Scrollable body */}
          <div className="overflow-y-auto flex-1 px-5 py-4">
            {type === "track" && <TrackContent track={data as MusicTrack} />}
            {type === "album" && <AlbumContent album={data as MusicAlbum} />}
            {type === "artist" && <ArtistContent artist={data as MusicArtist} />}
            {type === "playlist" && <PlaylistContent playlist={data as MusicPlaylist} />}
          </div>
        </div>
      </div>
    </>
  )
}
