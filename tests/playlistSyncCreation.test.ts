import { expect, test } from "bun:test"
import {
  createLinkedSync,
  reconcileSyncCreation,
  retainSyncCreation,
  SyncCreationError,
  type SyncCreationIntent,
  type SyncCreationServices,
} from "../src/playlistSync/creation"
import { retainLink } from "../src/playlistSync/linkedJournal"
import type { LinkedPlaylist } from "../src/playlistSync/linked"
const remote = { service: "listenbrainz", user: "owner", revision: "remote" },
  local = { service: "library:Plex", user: "scope", revision: "local" }
const source = {
  account: remote,
  id: "11111111-1111-4111-8111-111111111111",
  title: "Source",
  items: [
    {
      occurrenceId: "one",
      track: {
        id: "x",
        artist: "Artist",
        title: "Song",
        recordingMbid: "22222222-2222-4222-8222-222222222222",
      },
    },
  ],
}
function harness(exporting = false) {
  const selectedSource = exporting
    ? { ...source, account: local, id: "local", readOnly: true }
    : source
  const destinationAccount = exporting ? remote : local
  let intents: SyncCreationIntent[] = [],
    links: LinkedPlaylist[] = [],
    creates = 0,
    failReceipt = false,
    unknown = false,
    current = true,
    view = true
  const events: string[] = []
  const services: SyncCreationServices = {
    direction: exporting ? "export" : "import",
    current: () => current,
    admissionCurrent: () => view,
    source: {
      capabilities: { read: true, createCopy: false, replace: false },
      account: async () => selectedSource.account,
      read: async () => structuredClone(selectedSource),
      createCopy: async () => {
        throw Error("No source writes")
      },
    },
    target: {
      capabilities: { read: true, createCopy: true, replace: false },
      account: async () => destinationAccount,
      read: async (id) => ({
        account: destinationAccount,
        id,
        title: "Destination",
        items: [],
      }),
      createCopy: async (_title, tracks) => {
        events.push("create")
        creates++
        expect(tracks).toHaveLength(0)
        view = false
        if (unknown) throw Error("Lost response")
        return { id: "new" }
      },
    },
    journal: {
      load: async () => structuredClone(intents),
      save: async (intent) => {
        events.push(intent.state)
        if (failReceipt && intent.destinationId) throw Error("Disk unavailable")
        intents = retainSyncCreation(intents, intent)
      },
    },
    links: {
      load: async () => structuredClone(links),
      save: async (link, revision) => {
        links = retainLink(links, link, revision)
        return structuredClone(links[0])
      },
    },
  }
  return {
    source: selectedSource,
    services,
    events,
    creates: () => creates,
    intents: () => intents,
    links: () => links,
    receiptFailure: () => {
      failReceipt = true
    },
    repair: () => {
      failReceipt = false
    },
    unknown: () => {
      unknown = true
    },
    retire: () => {
      current = false
    },
  }
}
test("smart library exports create one remote destination and retain the source for song review", async () => {
  const h = harness(true)
  const result = await createLinkedSync(h.source.id, "Destination", h.services)
  expect(h.events.slice(0, 2)).toEqual(["admitting", "create"])
  expect(h.creates()).toBe(1)
  expect(result.intent.direction).toBe("export")
  expect(result.intent.sourceSnapshot).toEqual(h.source)
  expect(result.link.libraryPlaylistId).toBe("local")
  expect(result.link.listenbrainzPlaylistId).toBe("new")
  expect(result.link.library).toEqual(local)
  expect(result.link.listenbrainz).toEqual(remote)
  expect(result.link.baseline.library.readOnly).toBe(true)
  expect(result.link.baseline.listenbrainz.items).toHaveLength(0)
  expect(result.link.direction).toBe("export")
  expect(result.link.automatic).toBe(false)
  expect(result.link.paused).toBe(true)
  expect(result.link.incomplete).toBeUndefined()
  h.services.admissionCurrent = () => true
  await expect(
    createLinkedSync(h.source.id, "Destination", h.services)
  ).rejects.toThrow("already has a linked playlist")
  expect(h.creates()).toBe(1)
})
test("export creation retains unknown and failed receipts and recovers by reads without another create", async () => {
  for (const failure of ["unknown", "receipt", "retired"] as const) {
    const h = harness(true)
    if (failure === "unknown") h.unknown()
    if (failure === "receipt") h.receiptFailure()
    if (failure === "retired") {
      const create = h.services.target.createCopy
      h.services.target.createCopy = async (...args) => {
        const result = await create(...args)
        h.retire()
        return result
      }
    }
    let caught: SyncCreationError | undefined
    try {
      await createLinkedSync(h.source.id, "Destination", h.services)
    } catch (error) {
      caught = error as SyncCreationError
    }
    expect(caught).toBeInstanceOf(SyncCreationError)
    expect(caught!.intent.sourceSnapshot).toEqual(h.source)
    expect(h.links()).toHaveLength(0)
    h.repair()
    h.services.current = () => true
    const intent = { ...caught!.intent, destinationId: "new" }
    await h.services.journal.save(intent)
    const recovered = await reconcileSyncCreation(intent, h.services)
    expect(recovered.link.direction).toBe("export")
    expect(recovered.link.paused).toBe(true)
    expect(h.creates()).toBe(1)
  }
})
test("creation admits the full source before exactly one empty create and continues after its view closes", async () => {
  const h = harness(),
    result = await createLinkedSync(source.id, "Destination", h.services)
  expect(h.events.slice(0, 2)).toEqual(["admitting", "create"])
  expect(h.creates()).toBe(1)
  expect(result.intent.state).toBe("linked")
  expect(result.link.direction).toBe("import")
  expect(result.link.automatic).toBe(false)
  expect(result.link.incomplete?.sourceSnapshot.items).toEqual(source.items)
  expect(result.link.incomplete?.missingOccurrenceIds).toEqual(["one"])
  expect(result.link.baseline.library.items).toHaveLength(0)
})
test("unknown creation blocks another request across restart without dropping its source", async () => {
  const h = harness()
  h.unknown()
  await expect(
    createLinkedSync(source.id, "Destination", h.services)
  ).rejects.toBeInstanceOf(SyncCreationError)
  expect(h.intents()[0].state).toBe("reconcile")
  h.services.admissionCurrent = () => true
  await expect(
    createLinkedSync(source.id, "Destination", h.services)
  ).rejects.toThrow("previous creation")
  expect(h.creates()).toBe(1)
  expect(h.intents()[0].sourceSnapshot).toEqual(source)
})
test("failed known-ID retention remains recoverable without any second create", async () => {
  const h = harness()
  h.receiptFailure()
  let failure: SyncCreationError | undefined
  try {
    await createLinkedSync(source.id, "Destination", h.services)
  } catch (error) {
    failure = error as SyncCreationError
  }
  expect(failure?.unretained).toBe(true)
  expect(failure?.intent.destinationId).toBe("new")
  h.repair()
  await h.services.journal.save(failure!.intent)
  const recovered = await reconcileSyncCreation(failure!.intent, h.services)
  expect(recovered.intent.state).toBe("linked")
  expect(h.creates()).toBe(1)
  expect(h.links()).toHaveLength(1)
})
test("failed admission cannot create remotely and a retired post-create owner cannot attach a link", async () => {
  const h = harness()
  h.services.journal.save = async () => {
    throw Error("Disk unavailable")
  }
  await expect(
    createLinkedSync(source.id, "Destination", h.services)
  ).rejects.toThrow("Disk unavailable")
  expect(h.creates()).toBe(0)
  const retired = harness(),
    original = retired.services.target.createCopy
  retired.services.target.createCopy = async (...args) => {
    const result = await original(...args)
    retired.retire()
    return result
  }
  await expect(
    createLinkedSync(source.id, "Destination", retired.services)
  ).rejects.toBeInstanceOf(SyncCreationError)
  expect(retired.intents()[0].destinationId).toBe("new")
  expect(retired.links()).toHaveLength(0)
})
