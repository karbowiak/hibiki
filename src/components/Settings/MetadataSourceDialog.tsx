import { AppDialog } from "../shared/AppDialog"
import { SoulSyncSettings } from "./SoulSyncSettings"
import { MetadataServiceSettings } from "./MetadataServiceSettings"
import { TheAudioDbSettings } from "./TheAudioDbSettings"
import { getMetadataBackend } from "../../metadata"
import { plexBackend } from "../../backends/plex/definition"
import {
  SOURCE_LABELS,
  SOURCE_DESCRIPTIONS,
  type MetadataSource,
} from "../../stores/metadataSourceStore"
import { useSoulSyncStore } from "../../metadata/soulsync/store"
import {
  useFanartServiceStore,
  useHeyaServiceStore,
} from "../../metadata/services/store"
import { useTheAudioDbStore } from "../../metadata/theaudiodb/store"

export function MetadataSourceDialog({
  source,
  onClose,
}: {
  source: MetadataSource
  onClose: () => void
}) {
  const soulBusy = useSoulSyncStore((s) => s.loading)
  const fanartBusy = useFanartServiceStore((s) => s.loading)
  const heyaBusy = useHeyaServiceStore((s) => s.loading)
  const audioBusy = useTheAudioDbStore((s) => s.loading)
  const busy =
    source === "soulsync"
      ? soulBusy
      : source === "fanart"
        ? fanartBusy
        : source === "heya"
          ? heyaBusy
          : source === "theaudiodb"
            ? audioBusy
            : false
  const backend = getMetadataBackend(source)
  const Settings = backend?.SettingsComponent
  return (
    <AppDialog
      title={SOURCE_LABELS[source]}
      description={SOURCE_DESCRIPTIONS[source]}
      onClose={onClose}
      canClose={!busy}
      className="max-w-2xl"
    >
      {source === "soulsync" ? (
        <SoulSyncSettings embedded />
      ) : source === "fanart" || source === "heya" ? (
        <MetadataServiceSettings service={source} embedded />
      ) : source === "theaudiodb" ? (
        <TheAudioDbSettings embedded />
      ) : source === "plex" ? (
        <plexBackend.SettingsComponent />
      ) : Settings ? (
        <Settings />
      ) : (
        <div className="space-y-3 text-sm text-[var(--text-secondary)]">
          <p>
            This public source does not need an API key or a separate
            connection.
          </p>
          <p>
            {source === "wikidata"
              ? "Descriptions and Wikipedia links are selected through a verified MusicBrainz artist relationship."
              : "Approved cover artwork is selected through the album’s MusicBrainz release-group identity."}
          </p>
          <p>
            Move this source in Metadata Source Priority to change its
            preference. You can also choose a source for individual fields and
            artwork in the metadata editor.
          </p>
        </div>
      )}
    </AppDialog>
  )
}
