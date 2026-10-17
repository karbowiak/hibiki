import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores/playerStore"
import { useProviderStore } from "../stores/providerStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import type { MusicRadioMode } from "../lib/musicRadio"

export function QueueRadioControls() {
  const state = usePlayerStore(useShallow(state => ({ count: state.queue.length, active: state.isRadioMode,
    mode: state.radioMode, loading: state.radioLoading, error: state.radioError,
    enable: state.enableQueueRadio, stop: state.stopRadio, stream: state.isInternetRadioActive })))
  const plex = useProviderStore(state => !!state.provider?.createRadioQueue && !state.provider.isOffline)
  const youtube = useYoutubeMusicDiscoveryStore(state => state.connected)
  return <div className="border-b border-(--border) px-3 py-2" aria-label="Queue radio">
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-auto text-xs font-medium text-(--text-secondary)">Radio</span>
      {state.active || state.loading ? <button type="button" onClick={state.stop} className="discovery-pill !px-2 !py-1 text-xs">Turn off</button>
        : ([{ mode: "plex", label: "Plex", available: plex }, { mode: "ytmusic", label: "YTM", available: youtube },
          { mode: "mixed", label: "Mixed", available: plex && youtube }] as const).map(option =>
          <button key={option.mode} type="button" aria-label={`Enable ${option.label} radio for this queue`}
            disabled={!state.count || state.stream || !option.available} aria-pressed={state.active && state.mode === option.mode}
            onClick={() => void state.enable(option.mode as MusicRadioMode)}
            title={option.available ? "Keep this queue and append recommendations" : `Connect ${option.label === "Mixed" ? "Plex and YouTube Music" : option.label} to use this radio`}
            className="discovery-pill !px-2 !py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40">{option.label}</button>)}
    </div>
    {state.loading ? <p role="status" className="mt-1 text-xs text-(--text-secondary)">Loading radio recommendations…</p>
      : state.active ? <p role="status" className="mt-1 text-xs text-(--text-secondary)">{state.mode === "mixed" ? "Plex + YTM" : state.mode === "plex" ? "Plex" : "YTM"} radio is on. Your queued songs stay in order.</p>
      : !state.count ? <p className="mt-1 text-xs text-(--text-secondary)">Add a song to enable radio.</p> : null}
    {state.error && <p role="alert" className="mt-1 text-xs text-(--text-secondary)">{state.error}</p>}
  </div>
}
