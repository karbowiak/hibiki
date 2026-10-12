import { expect, test } from "bun:test"
import {
  createSoulSyncAdapter,
  type SoulSyncReadRequest,
} from "../src/metadata/core/soulSync"
import { createMetadataClient } from "../src/metadata/core/client"
const identity = {
  kind: "artist" as const,
  artist: "Artist & Name",
  scope: "account/library",
}
test("optional SoulSync has no automatic credential discovery and uses verified bounded GET routes", async () => {
  const requests: SoulSyncReadRequest[] = []
  const adapter = createSoulSyncAdapter(
    {
      baseUrl: "https://synthetic.test/proxy",
      getApiKey: () => "synthetic-test-key",
    },
    async (request) => {
      requests.push(request)
      const listing = requests.length === 1
      return {
        status: 200,
        finalUrl: request.url,
        body: {
          success: true,
          data: listing
            ? { artists: [{ id: 42, name: "Artist & Name" }] }
            : {
                artist: {
                  id: 42,
                  name: "Artist & Name",
                  summary: "Biography",
                  genres: ["Pop"],
                  thumb_url: "https://images.test/art",
                  musicbrainz_id: "synthetic-mbid",
                },
              },
        },
      }
    }
  )
  const result = await adapter.lookup(identity)
  expect(result).toMatchObject({
    status: "ready",
    snapshot: {
      source: "soulsync",
      fields: { biography: "Biography", genres: ["Pop"] },
      match: { kind: "exact-name" },
    },
  })
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/proxy/api/v1/library/artists",
    "/proxy/api/v1/library/artists/42",
  ])
  expect(new URL(requests[0].url).searchParams.get("search")).toBe(
    "Artist & Name"
  )
  expect(new URL(requests[0].url).searchParams.get("limit")).toBe("5")
  expect(
    requests.every(
      (request) =>
        request.method === "GET" &&
        request.redirect === "error" &&
        request.maxBytes === 1048576 &&
        !request.url.includes("synthetic-test-key")
    )
  ).toBe(true)
})
test("SoulSync disabled configuration, ambiguous names, unsupported kinds and unsafe bases make no extra request", async () => {
  let calls = 0
  const transport = async (request: SoulSyncReadRequest) => {
    calls++
    return {
      status: 200,
      finalUrl: request.url,
      body: {
        success: true,
        data: {
          artists: [
            { id: 1, name: identity.artist },
            { id: 2, name: identity.artist },
          ],
        },
      },
    }
  }
  const disabled = createSoulSyncAdapter(
    { baseUrl: "http://synthetic.test", getApiKey: () => null },
    transport
  )
  expect(await disabled.lookup(identity)).toEqual({ status: "unavailable" })
  expect(calls).toBe(0)
  const enabled = createSoulSyncAdapter(
    { baseUrl: "https://synthetic.test", getApiKey: () => "synthetic" },
    transport
  )
  expect(
    await enabled.lookup({ ...identity, kind: "album", title: "Album" })
  ).toEqual({ status: "unsupported" })
  expect(calls).toBe(0)
  expect(await enabled.lookup(identity)).toMatchObject({ status: "ambiguous" })
  expect(calls).toBe(1)
  for (const baseUrl of [
    "https://token@synthetic.test",
    "https://synthetic.test?key=secret",
    "file:///tmp/config",
  ])
    expect(() =>
      createSoulSyncAdapter({ baseUrl, getApiKey: () => null }, transport)
    ).toThrow()
})
test("SoulSync rejects redirect/error payloads and retires credentials without leaking upstream error text", async () => {
  const redirect = createSoulSyncAdapter(
    { baseUrl: "https://synthetic.test", getApiKey: () => "synthetic" },
    async (request) => ({
      status: 200,
      finalUrl: "https://foreign.test",
      body: { success: true, data: { artists: [] } },
    })
  )
  const client = createMetadataClient([redirect], () => ({
    scope: identity.scope,
    token: "stable",
  }))
  expect(await client.lookup("soulsync", identity)).toEqual({
    status: "error",
    code: "lookup-failed",
    retryable: true,
  })
  let key: string | null = "synthetic"
  const retired = createSoulSyncAdapter(
    { baseUrl: "https://synthetic.test", getApiKey: () => key },
    async (request) => {
      key = null
      return {
        status: 200,
        finalUrl: request.url,
        body: { success: true, data: { artists: [] } },
      }
    }
  )
  expect(await retired.lookup(identity)).toEqual({ status: "retired" })
})
