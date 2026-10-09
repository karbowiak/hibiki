import { describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { isHttpUrl, sanitizePlexHtml } from "../src/lib/richText"

const dom = new JSDOM()
globalThis.window = dom.window as unknown as Window & typeof globalThis

function parse(raw: string) {
  return new dom.window.DOMParser().parseFromString(
    sanitizePlexHtml(raw),
    "text/html"
  ).body
}

describe("untrusted Plex descriptions", () => {
  test("encoded markup remains text when the sanitized HTML is rendered", () => {
    const body = parse('&lt;img src=x onerror="alert(1)"&gt;')
    expect(body.querySelector("img")).toBeNull()
    expect(body.textContent).toBe('<img src=x onerror="alert(1)">')
  })

  test("decoded quotes cannot introduce attributes", () => {
    const body = parse(
      '<a href="https://example.com/&quot; onmouseover=&quot;alert(1)">artist</a>'
    )
    expect(body.querySelector("[onmouseover]")).toBeNull()
    expect(body.querySelector("a")?.attributes.length).toBe(1)
  })

  test("scripts, event handlers, embedded frames and SVG are removed", () => {
    const body = parse(
      '<script>alert(1)</script><svg onload="alert(1)"></svg><iframe srcdoc="bad"></iframe><b onclick="alert(1)">artist</b>'
    )
    expect(body.querySelector("script,svg,iframe,[onclick]")).toBeNull()
    expect(body.textContent).toBe("artist")
  })

  test.each([
    "javascript:alert(1)",
    "data:text/html,bad",
    "file:///tmp/bad",
    "//example.com",
    "/relative",
  ])("rejects the external link %s", (href) => {
    expect(
      parse(`<a href="${href}">artist</a>`).querySelector("[href]")
    ).toBeNull()
    expect(isHttpUrl(href)).toBe(false)
  })

  test("retains safe formatting, text entities, and browser links", () => {
    const body = parse(
      '<strong>AT&amp;T</strong><br><a href="https://example.com/?a=1&amp;b=2">artist</a>'
    )
    expect(body.querySelector("strong")?.textContent).toBe("AT&T")
    expect(body.querySelector("br")).not.toBeNull()
    expect(body.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/?a=1&b=2"
    )
    expect(isHttpUrl("https://example.com/?a=1&b=2")).toBe(true)
  })

  test("handles truncated description links without creating markup", () => {
    expect(parse('Biography <a href="https://example.com').textContent).toBe(
      "Biography"
    )
  })
})
