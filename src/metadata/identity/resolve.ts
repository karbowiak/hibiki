import {
  identityChoiceFor,
  metadataIdentityItemKey,
  useMetadataIdentityStore,
} from "../../stores/metadataIdentityStore"
import { useHeyaServiceStore } from "../services/store"
import type { MetadataIdentity } from "../core/types"
import type { MetadataIdentityResolution } from "./types"
export function resolveMetadataIdentity(
  identity: MetadataIdentity
): MetadataIdentityResolution {
  const state = useMetadataIdentityStore.getState(),
    key = metadataIdentityItemKey(identity),
    record = identityChoiceFor(identity, state.choices)
  const status = useHeyaServiceStore.getState().status
  const applicable =
    record?.candidate.provider !== "heya" ||
    (!!status?.connectionId &&
      record.candidate.connectionId === status.connectionId)
  const ready = state.hydrated || (!!key && Object.hasOwn(state.choices, key))
  const choice = applicable ? (record?.candidate ?? null) : null
  return {
    original: { ...identity },
    choice,
    lookupArtist: choice?.artist ?? identity.artist,
    lookupTitle:
      identity.kind === "album" ? (choice?.title ?? identity.title) : undefined,
    artistMbid: choice?.identifiers.artistMbid,
    releaseGroupMbid: choice?.identifiers.releaseGroupMbid,
    heyaId: choice?.provider === "heya" ? choice.id : undefined,
    connectionId: choice?.connectionId,
    lease: JSON.stringify([
      key ?? identity.scope,
      record?.version ?? null,
      key ? (state.versions[key] ?? 0) : 0,
      applicable,
      ready,
    ]),
    ready: ready,
    blockedReason:
      record && !applicable
        ? "This reviewed identity belongs to a different HeyaMetadata connection. Review the match again."
        : undefined,
  }
}
