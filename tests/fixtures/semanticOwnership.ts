import assert from "node:assert/strict"
import { mock } from "bun:test"
import { create } from "zustand"
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const scenario = process.argv[2]
const documentsA = deferred<any[]>()
const searchA = deferred<any[]>()
const putA = deferred<void>()
let workers = 0
let closes = 0
let documents = 0
let downloads = 0
const writes: string[] = []
const embeddings: string[][] = []
const settings = create(() => ({
  enabled: scenario !== "disabled",
  installed: true,
  checkInstalled: async () => {
    downloads++
  },
  download: async () => {
    throw new Error("must not download")
  },
}))
mock.module("../../src/semantic/store", () => ({
  useSemanticSettingsStore: settings,
}))
mock.module("../../src/semantic/workerClient", () => ({
  createEmbeddingWorker: async () => {
    workers++
    let closed = false
    return {
      embed: async (texts: string[]) => {
        embeddings.push(texts)
        return texts.map(() => [1, ...Array(383).fill(0)])
      },
      close: () => {
        if (!closed) {
          closed = true
          closes++
        }
      },
    }
  },
}))
mock.module("../../src/semantic/api", () => ({
  createSemanticApi: (context: any) => ({
    documents: async () => {
      documents++
      if (context.cacheScope === "A" && scenario === "account")
        return documentsA.promise
      return [
        {
          kind: "album",
          id: context.cacheScope,
          title: "Item",
          artist: "Artist",
          text: "Calm music",
          textHash: "hash",
          indexed: scenario === "missing",
        },
      ].concat(
        scenario === "missing"
          ? [
              {
                kind: "album",
                id: "new",
                title: "New",
                artist: "Artist",
                text: "Metal music",
                textHash: "newhash",
                indexed: false,
              },
            ]
          : []
      )
    },
    put: async () => {
      writes.push(context.cacheScope)
      if (scenario === "disable" && context.cacheScope === "A")
        await putA.promise
    },
    search: async () =>
      scenario === "search" && context.cacheScope === "A"
        ? searchA.promise
        : [
            {
              kind: "album",
              id: context.cacheScope,
              title: "Current",
              artist: "Artist",
              score: 1,
            },
          ],
  }),
}))
const module = await import("../../src/semantic/discovery")
const settle = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve()
}
module.activateSemanticContext({ connectionRevision: 1, cacheScope: "A" })
await settle()
if (scenario === "account") {
  module.activateSemanticContext({ connectionRevision: 2, cacheScope: "B" })
  await settle()
  documentsA.resolve([
    { kind: "album", id: "old", text: "Old account", textHash: "old" },
  ])
  await settle()
  assert.deepEqual(writes, ["B"])
  assert.equal(module.useSemanticDiscovery.getState().scope, "B")
  assert.equal(module.useSemanticDiscovery.getState().indexed, 1)
  assert(closes >= 1)
} else if (scenario === "search") {
  const pending = module.searchSemantic("calm")
  await settle()
  module.activateSemanticContext({ connectionRevision: 2, cacheScope: "B" })
  await settle()
  searchA.resolve([{ kind: "album", id: "old", title: "OLD", score: 1 }])
  await assert.rejects(pending, /account changed/)
  assert.equal(module.useSemanticDiscovery.getState().scope, "B")
} else if (scenario === "disable") {
  settings.setState({ enabled: false })
  putA.resolve()
  await settle()
  assert.equal(module.useSemanticDiscovery.getState().status, "disabled")
  assert.equal(module.useSemanticDiscovery.getState().indexed, 0)
  assert(closes >= 1)
} else if (scenario === "disabled") {
  assert.equal(workers, 0)
  assert.equal(documents, 0)
  assert.equal(downloads, 0)
  await assert.rejects(module.searchSemantic("calm"), /Enable/)
} else if (scenario === "missing") {
  assert.deepEqual(embeddings, [["Metal music"]])
  assert.equal(module.useSemanticDiscovery.getState().indexed, 2)
} else throw new Error("Unknown scenario")
module.activateSemanticContext(null)
