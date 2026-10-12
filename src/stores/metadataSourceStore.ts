/**
 * Metadata source priority — persisted to IndexedDB via Zustand persist.
 *
 * Controls the order in which metadata sources are consulted for bio text,
 * images, genres, tags, and supplemental info.
 *
 * NOTE: Artist name, album name, and track name ALWAYS come from Plex
 * regardless of this setting — this only affects enrichment data.
 */

import { create } from "zustand"
import { safePersist } from "./idbStorage"

export type MetadataSource =
  | "plex"
  | "deezer"
  | "lastfm"
  | "apple"
  | "musicbrainz"
  | "wikidata"
  | "coverartarchive"
  | "fanart"
  | "heya"

export const SOURCE_LABELS: Record<MetadataSource, string> = {
  plex: "Plex",
  deezer: "Deezer",
  lastfm: "Last.fm",
  apple: "Apple Music",
  musicbrainz: "MusicBrainz",
  wikidata: "Wikidata",
  coverartarchive: "Cover Art Archive",
  fanart: "Fanart.tv",
  heya: "HeyaMetadata",
}

export const SOURCE_DESCRIPTIONS: Record<MetadataSource, string> = {
  fanart:
    "Configured Fanart.tv artist backgrounds, portraits, and matched album covers",
  heya: "Metadata from your configured HeyaMetadata server, with source provenance",
  plex: "Your Plex library metadata (always the source for names)",
  deezer: "Deezer artist images, fan counts, genres, and cover art",
  lastfm: "Last.fm biographies, tags, listener counts, and similar artists",
  apple: "Apple Music genres, release dates, and album artwork",
  musicbrainz: "MusicBrainz tags/genres, release data, and artist info",
  wikidata:
    "Verified artist descriptions and Wikipedia links (not biographies)",
  coverartarchive:
    "Approved album covers matched by MusicBrainz release-group identity",
}

const DEFAULT_PRIORITY: MetadataSource[] = [
  "plex",
  "deezer",
  "lastfm",
  "apple",
  "musicbrainz",
  "wikidata",
  "coverartarchive",
  "fanart",
  "heya",
]

interface MetadataSourceState {
  /** Ordered list of metadata sources, highest priority first. */
  priority: MetadataSource[]
  /** Replace the entire ordering. */
  setPriority: (order: MetadataSource[]) => void
}

export const useMetadataSourceStore = create<MetadataSourceState>()(
  safePersist(
    (set) => ({
      priority: DEFAULT_PRIORITY,
      setPriority: (order) => set({ priority: order }),
    }),
    {
      name: "metadata-source-priority-v1",
      validate: (state) =>
        state.priority === undefined ||
        (Array.isArray(state.priority) &&
          state.priority.every((source) => typeof source === "string")),
      partialize: (s) => ({ priority: s.priority }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        // Ensure newly added sources appear in existing saved priority lists
        const missing = DEFAULT_PRIORITY.filter(
          (s) => !state.priority.includes(s)
        )
        if (missing.length > 0) {
          useMetadataSourceStore.setState({
            priority: [...state.priority, ...missing],
          })
        }
      },
    }
  )
)
