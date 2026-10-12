import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { albumMatches, albumMatchesCacheKey } from "../src/metadata/albumMatch"

test("album identity preserves artist, accents and named editions while accepting provider format suffixes", () => {
  expect(albumMatches({ artist: "YOSHIKO", title: "Bumble Bee - Single" }, " Yoshiko ", "Bumble  Bee")).toBe(true)
  expect(albumMatches({ artist: "BJÖRK", title: "Vespertine" }, "Björk", "Vespertine")).toBe(true)
  expect(albumMatches({ artist: "Yoshiko", title: "Bumble Bee - EP" }, "Yoshiko", "Bumble Bee - Single")).toBe(false)
  for (const data of [
    { artist: "Various Artists", title: "100 Silly Sing Along Songs for Kids" },
    { artist: "Godsmack", title: "Bumble Bee" },
    { artist: "Yoshiko", title: "Different Album" },
    ...["Live", "Named Remix", "Deluxe Edition"].map(edition => ({ artist: "Yoshiko", title: `Bumble Bee (${edition})` })),
    { artist: "", title: "" }, {}, null,
  ]) expect(albumMatches(data, "Yoshiko", "Bumble Bee")).toBe(false)
  expect(albumMatches({ artist: "Björk", title: "Vespertine" }, "Bjork", "Vespertine")).toBe(false)
  expect(albumMatchesCacheKey({ artist: "Artist::Name", title: "Album" }, "artist::name::album")).toBe(true)
  expect(albumMatchesCacheKey({ artist: "Artist:: Name", title: "Album" }, " artist:: name  :: album ")).toBe(true)
  expect(albumMatchesCacheKey({ artist: "Artist", title: "Album" }, "artist2::album")).toBe(false)
})
for (const scenario of ["hydration", "getter", "render"]) {
  test(`external album identity cache/artwork: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "tests/fixtures/albumArtworkIdentity.tsx", scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    const [status, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
  })
}
