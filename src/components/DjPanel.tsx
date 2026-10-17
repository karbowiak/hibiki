import { useState } from "react"
import { IconLoader2, IconPlayerPlay } from "@tabler/icons-react"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores"
import { DJ_MODES } from "../stores/playerStore"
import { useProviderStore } from "../stores/providerStore"
import { useCapability } from "../hooks/useCapability"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import { hasIndependentAudio, isYoutubeMusicTrack } from "../backends/ytmusic/tracks"
import type { MusicRadioMode } from "../lib/musicRadio"
import { PlayerPanelHeader } from "./shared/PlayerPanelHeader"
import { PlexLogo, YoutubeMusicLogo } from "./shared/MusicSource"

export default function DjPanel({ onClose }: { onClose: () => void }) {
  const { djMode, setDjMode, currentTrack, isInternetRadioActive, isRadioMode, radioMode, playRadio, playerError } = usePlayerStore(
    useShallow(s => ({ djMode: s.djMode, setDjMode: s.setDjMode, currentTrack: s.currentTrack,
      isInternetRadioActive: s.isInternetRadioActive, isRadioMode: s.isRadioMode, radioMode: s.radioMode,
      playRadio: s.playRadio, playerError: s.playerError })),
  )
  const provider = useProviderStore(s => s.provider)
  const hasRadio = useCapability("radio")
  const hasDjModes = useCapability("djModes")
  const connected = useYoutubeMusicDiscoveryStore(s => s.connected)
  const [starting, setStarting] = useState<MusicRadioMode | null>(null)
  const musicSeed = !!currentTrack && !isInternetRadioActive && !currentTrack.mediaInfo?.localAudio &&
    (!hasIndependentAudio(currentTrack) || isYoutubeMusicTrack(currentTrack))
  const plexAvailable = hasRadio && !!provider?.createRadioQueue && !provider.isOffline
  const canDj = hasDjModes && musicSeed && !!currentTrack && !isYoutubeMusicTrack(currentTrack) && !provider?.isOffline
  const disabled = !musicSeed || starting !== null
  const start = async (mode: MusicRadioMode) => {
    if (!currentTrack || starting) return
    setStarting(mode)
    try {
      await playRadio(currentTrack.id, "track", currentTrack.title, mode, currentTrack)
      const state = usePlayerStore.getState()
      if (state.isRadioMode && state.radioSeedKey === currentTrack.id && !state.playerError) onClose()
    } finally { setStarting(null) }
  }
  const radioButton = (mode: "plex" | "ytmusic", available: boolean, name: string) => (
    <button type="button" disabled={disabled || !available} aria-pressed={isRadioMode && radioMode === mode}
      onClick={() => { void start(mode) }} className="player-panel-option flex w-full items-center justify-center gap-2 !py-2.5 disabled:cursor-default disabled:opacity-40">
      {starting === mode ? <IconLoader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <IconPlayerPlay size={14} aria-hidden="true" />}
      {name}
    </button>
  )
  return (
    <div>
      <PlayerPanelHeader title="Radio & Guest DJ" onClose={onClose} subtitle={musicSeed ? currentTrack?.title : "Play a song to start radio"} />
      <div className="grid grid-cols-2 divide-x divide-(--border)">
        <section className="min-w-0 p-3" aria-label="Plex listening options">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><PlexLogo size={16} /> Plex</h3>
          {radioButton("plex", plexAvailable, "Plex radio")}
          {!plexAvailable && <p className="mt-2 text-xs text-(--text-secondary)">Connect to Plex to use radio.</p>}
          {hasDjModes && <div className="mt-4">
            <h4 className="mb-1 px-1 text-xs font-medium text-(--text-secondary)">Guest DJ</h4>
            {DJ_MODES.map(dj => (
              <button key={dj.key} type="button" disabled={!canDj || !!starting} aria-pressed={djMode === dj.key}
                title={dj.desc} onClick={() => { setDjMode(djMode === dj.key ? null : dj.key); onClose() }}
                className="player-panel-option mt-1 block w-full !px-2 !py-2 text-left !text-xs disabled:cursor-default disabled:opacity-40">
                {dj.name}
              </button>
            ))}
            {djMode && <button type="button" onClick={() => { setDjMode(null); onClose() }} className="player-panel-action mt-2 w-full">Turn off Guest DJ</button>}
          </div>}
        </section>
        <section className="min-w-0 p-3" aria-label="YouTube Music listening options">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><YoutubeMusicLogo size={16} /> YTM</h3>
          {radioButton("ytmusic", connected, "YTM radio")}
          <p className="mt-3 text-xs leading-relaxed text-(--text-secondary)">
            {connected ? "Recommendations from YouTube Music, based on this song." : "Sign in to YouTube Music to use YTM radio."}
          </p>
        </section>
      </div>
      {playerError && <p role="alert" className="px-4 pb-3 text-xs text-(--text-secondary)">{playerError}</p>}
      <div className="sticky bottom-0 border-t border-(--border) bg-(--bg-surface) p-3">
        <button type="button" disabled={disabled || !plexAvailable || !connected} aria-pressed={isRadioMode && radioMode === "mixed"}
          onClick={() => { void start("mixed") }}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-40">
          {starting === "mixed" ? <IconLoader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <><PlexLogo size={15} /><YoutubeMusicLogo size={15} /></>}
          Radio
        </button>
        <p className="mt-2 text-center text-xs text-(--text-secondary)">5 Plex + 5 YTM songs, alternating</p>
      </div>
    </div>
  )
}
