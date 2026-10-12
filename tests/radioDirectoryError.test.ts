import { expect, test } from "bun:test"
import { radioDirectoryErrorHint } from "../src/lib/radioDirectoryError"

test("radio failures explain actionable native and upstream causes", () => {
  expect(
    radioDirectoryErrorHint("Command radiobrowser_top_stations not found")
  ).toContain("missing a radio command")
  expect(
    radioDirectoryErrorHint(new Error("invalid args `category`"))
  ).toContain("rejected the radio request")
  expect(
    radioDirectoryErrorHint(
      new TypeError("Cannot read properties of undefined (reading 'invoke')")
    )
  ).toContain("desktop app")
  expect(radioDirectoryErrorHint("TLS certificate invalid")).toContain(
    "secure connection"
  )
  expect(radioDirectoryErrorHint("HTTP 429 Too Many Requests")).toContain(
    "busy"
  )
  expect(radioDirectoryErrorHint("request timed out")).toContain(
    "did not respond in time"
  )
  expect(radioDirectoryErrorHint("Failed to parse station response")).toContain(
    "data that could not be read"
  )
})

test("radio error hints never echo remote content or credential-bearing URLs", () => {
  for (const error of [
    "https://user:secret@example.invalid/?token=private",
    new Error("Failed to parse https://example.invalid/?token=private"),
    { message: "secret" },
    null,
  ]) {
    const hint = radioDirectoryErrorHint(error)
    expect(hint).not.toContain("secret")
    expect(hint).not.toContain("private")
    expect(hint).not.toContain("https:")
  }
})
