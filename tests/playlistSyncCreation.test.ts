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
function harness() {
  let intents: SyncCreationIntent[] = [],
    links: LinkedPlaylist[] = [],
    creates = 0,
    failReceipt = false,
    unknown = false,
    current = true,
    view = true
  const events: string[] = []
  const services: SyncCreationServices = {
    current: () => current,
    admissionCurrent: () => view,
    source: {
      capabilities: { read: true, createCopy: false, replace: false },
      account: async () => remote,
      read: async () => structuredClone(source),
      createCopy: async () => {
        throw Error("No source writes")
      },
    },
    target: {
      capabilities: { read: true, createCopy: true, replace: false },
      account: async () => local,
      read: async (id) => ({
        account: local,
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
