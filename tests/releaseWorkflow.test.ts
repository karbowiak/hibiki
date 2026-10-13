import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

// Execute the real workflow script against an offline GitHub mock.
const workflow = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8"
)
const config = Bun.YAML.parse(workflow) as {
  jobs: Record<string, { steps: { id?: string; with?: { script?: string } }[] }>
}
const script = config.jobs["create-release"].steps.find(
  (step) => step.id === "create-release"
)?.with?.script
if (!script) throw new Error("Release creation script is missing")
const run = new (Object.getPrototypeOf(async function () {}).constructor)(
  "github",
  "context",
  "process",
  "require",
  script
)

function mock(releases: { id: number; tag_name: string; draft: boolean }[]) {
  const calls: unknown[] = []
  const listReleases = () => {
    throw new Error("Pagination should use the endpoint reference")
  }
  return {
    calls,
    github: {
      rest: {
        repos: {
          listReleases,
          createRelease: async (args: unknown) => {
            calls.push(args)
            return { data: { id: 99 } }
          },
          updateRelease: async (args: unknown) => {
            calls.push(args)
            return { data: { id: 42 } }
          },
        },
      },
      paginate: async (endpoint: unknown, args: unknown) => {
        expect(endpoint).toBe(listReleases)
        expect(args).toEqual({ owner: "owner", repo: "repo", per_page: 100 })
        return releases
      },
    },
  }
}

function execute(github: unknown, version = "0.5.2") {
  return run(
    github,
    { repo: { owner: "owner", repo: "repo" } },
    { env: { RELEASE_TAG: `v${version}`, VERSION: version } },
    createRequire(import.meta.url)
  )
}

test("release retries reuse the matching draft without creating or replacing assets", async () => {
  const { github, calls } = mock([
    { id: 1, tag_name: "v0.5.1", draft: false },
    { id: 42, tag_name: "v0.5.2", draft: true },
  ])
  expect(await execute(github)).toBe(42)
  expect(calls).toEqual([])
})

test("published releases cannot be rebuilt", async () => {
  const { github, calls } = mock([{ id: 42, tag_name: "v0.5.2", draft: false }])
  await expect(execute(github)).rejects.toThrow(
    "already published; refusing to replace its assets"
  )
  expect(calls).toEqual([])
})

for (const publishedFirst of [false, true]) {
  test(`a published tag cannot be rebuilt through a stale draft (${publishedFirst ? "published" : "draft"} listed first)`, async () => {
    const releases = [
      { id: 42, tag_name: "v0.5.2", draft: true },
      { id: 43, tag_name: "v0.5.2", draft: false },
    ]
    const { github, calls } = mock(
      publishedFirst ? releases.reverse() : releases
    )
    await expect(execute(github)).rejects.toThrow(
      "already published; refusing to replace its assets"
    )
    expect(calls).toEqual([])
  })
}

test("new tags create a draft and retain the release ID output", async () => {
  const { github, calls } = mock([{ id: 1, tag_name: "v0.5.1", draft: false }])
  expect(await execute(github)).toBe(99)
  expect(calls).toEqual([
    {
      owner: "owner",
      repo: "repo",
      tag_name: "v0.5.2",
      name: "Hibiki v0.5.2",
      body: "*This release was generated automatically using GitHub Actions.*",
      draft: true,
      prerelease: false,
    },
  ])
})

test("release listing failures stop before creating a release", async () => {
  const { github, calls } = mock([])
  github.paginate = async () => {
    throw new Error("Permission denied")
  }
  await expect(execute(github)).rejects.toThrow("Permission denied")
  expect(calls).toEqual([])
})

test("versioned release notes populate new drafts and refresh matching drafts only", async () => {
  const body = readFileSync(new URL("../releases/0.6.0.md", import.meta.url), "utf8")
  const fresh = mock([])
  expect(await execute(fresh.github, "0.6.0")).toBe(99)
  expect(fresh.calls).toEqual([{ owner: "owner", repo: "repo", tag_name: "v0.6.0", name: "Hibiki v0.6.0", body, draft: true, prerelease: false }])
  const retry = mock([{ id: 42, tag_name: "v0.6.0", draft: true }])
  expect(await execute(retry.github, "0.6.0")).toBe(42)
  expect(retry.calls).toEqual([{ owner: "owner", repo: "repo", release_id: 42, body }])
  const published = mock([{ id: 42, tag_name: "v0.6.0", draft: false }])
  await expect(execute(published.github, "0.6.0")).rejects.toThrow("already published")
  expect(published.calls).toEqual([])
})
