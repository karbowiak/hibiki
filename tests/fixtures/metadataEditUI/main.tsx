import React, { useState } from "react"
import { createRoot } from "react-dom/client"
import { MetadataEditDialog } from "../../../src/components/shared/MetadataEditDialog"
import { useProviderStore } from "../../../src/stores/providerStore"
import { useMetadataSourceStore } from "../../../src/stores/metadataSourceStore"
import { useSoulSyncStore } from "../../../src/metadata/soulsync/store"
import { setTheme } from "../../../src/stores/themeStore"
import { setFont } from "../../../src/stores/fontStore"
import "../../../src/styles.css"
const item: any = {
  id: "fixture-album",
  title: "Synthetic album with a comfortably long title",
  artistName: "Synthetic artist",
  summary:
    "A synthetic album description for layout and safe metadata editing checks.",
  releaseDate: "2026-10-12",
  thumbUrl: location.origin + "/synthetic-cover.svg",
  artUrl: location.origin + "/synthetic-background.svg",
  genres: ["Electronic"],
  year: 2026,
  trackCount: 12,
}
let writes: any[] = [],
  finish: (() => void) | null = null
useMetadataSourceStore.setState({ priority: ["plex"] })
useSoulSyncStore.setState({ status: null, load: async () => {} })
useProviderStore.getState().setProvider({
  cacheScope: "synthetic:metadata-ui",
  playbackSession: "synthetic-session",
  name: "Synthetic library",
  capabilities: { metadataEdit: true },
  getAlbum: async () => item,
  getArtist: async () => ({ ...item, id: "fixture-artist" }),
  editMetadata: (...args: any[]) => {
    writes.push(args)
    return new Promise<void>((resolve) => {
      finish = resolve
    })
  },
} as any)
function Fixture() {
  const [open, setOpen] = useState(false)
  return (
    <main className="bg-app-base min-h-screen p-8 text-[var(--text-primary)]">
      <h1 className="mb-4 text-2xl font-semibold">Synthetic library</h1>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-accent-on rounded-full bg-accent px-5 py-2"
      >
        Edit album
      </button>
      {open && (
        <MetadataEditDialog
          kind="album"
          item={item}
          backgroundUrl={item.artUrl}
          onClose={() => setOpen(false)}
        />
      )}
    </main>
  )
}
setFont("inter")
setTheme("dark")
;(window as any).metadataEditFixture = {
  writes: () => writes.length,
  settle: () => {
    finish?.()
    finish = null
  },
  theme: setTheme,
}
createRoot(document.getElementById("root")!).render(<Fixture />)
