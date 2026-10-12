import assert from "node:assert/strict"
import { resolve } from "node:path"
import { parse } from "postcss"
import { chromium, webkit } from "playwright"
const root = resolve(import.meta.dir, "..")
const source = parse(await Bun.file(resolve(root, "src/styles.css")).text())
// Use production semantic variable declarations without loading font packages
// or requiring a full app build/network access for this focused CSS check.
const themes: string[] = []
source.walkRules((rule) => {
  if (rule.selector === ":root" || rule.selector === '[data-theme="light"]')
    themes.push(rule.toString())
})
assert.ok(themes.length >= 2)
const shell = await Bun.file(
  resolve(root, "src/styles/shellArtwork.css")
).text()
const reduced = parse(shell).nodes.find(
  (node) =>
    node.type === "atrule" &&
    node.name === "media" &&
    node.params === "(prefers-reduced-transparency: reduce)"
)
assert.ok(reduced?.type === "atrule")
const reducedRules = reduced.nodes!.map((node) => node.toString()).join("\n")
for (const [name, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
] as const) {
  const browser = await type.launch({
    headless: true,
    ...(name === "chromium" && process.env.HIBIKI_CHROME_CHANNEL
      ? { channel: process.env.HIBIKI_CHROME_CHANNEL }
      : {}),
  })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await context.route("**/*", (route) => route.abort())
    await page.setContent(
      `<style>${themes.join("\n")}\n${shell}</style><main id="app"><nav class="shell-artwork-surface">Sidebar</nav><header class="shell-artwork-surface shell-artwork-toolbar">Toolbar</header><footer class="shell-artwork-surface shell-artwork-player"><div class="shell-artwork-player-inner">Player</div></footer></main>`
    )
    const state = async (
      theme: string,
      ready: boolean,
      enabled: boolean,
      opacity: number
    ) => {
      await page.evaluate(
        ({ theme, ready, enabled, opacity }) => {
          document.documentElement.dataset.theme = theme
          const app = document.getElementById("app")!
          app.dataset.artworkBackground = ready ? "ready" : "missing"
          app.style.setProperty("--interface-opacity", String(opacity))
          for (const surface of document.querySelectorAll<HTMLElement>(
            ".shell-artwork-surface"
          ))
            surface.dataset.shellTransparency = enabled ? "enabled" : "disabled"
        },
        { theme, ready, enabled, opacity }
      )
      return await page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLElement>(".shell-artwork-surface"),
        ].map((surface) => {
          const style = getComputedStyle(surface),
            canvas = document.createElement("canvas")
          canvas.width = canvas.height = 1
          const ctx = canvas.getContext("2d")!
          ctx.fillStyle = style.backgroundColor
          ctx.fillRect(0, 0, 1, 1)
          return {
            alpha: ctx.getImageData(0, 0, 1, 1).data[3] / 255,
            color: style.backgroundColor,
            blur: style.backdropFilter,
          }
        })
      )
    }
    let count = 0
    for (const theme of ["dark", "light"])
      for (const opacity of [0.45, 0.76, 1]) {
        for (const [ready, enabled] of [
          [false, true],
          [true, false],
          [true, true],
        ]) {
          const actual = await state(theme, ready, enabled, opacity)
          assert.equal(
            new Set(actual.map((surface) => surface.color)).size,
            1,
            `${name}: shell surfaces must have identical tint`
          )
          for (const surface of actual) {
            const expected = ready && enabled ? Math.max(0.68, opacity) : 1
            assert.ok(
              Math.abs(surface.alpha - expected) < 0.01,
              `${name}/${theme}/${opacity}/${ready}/${enabled}: ${JSON.stringify(surface)}`
            )
            assert.notEqual(surface.color, "rgba(0, 0, 0, 0)")
          }
          count++
        }
      }
    for (const [theme, custom] of [
      ["dark", "#213246"],
      ["light", "#dce4eb"],
    ]) {
      await page.evaluate(
        (custom) =>
          document
            .getElementById("app")!
            .style.setProperty("--bg-base", custom),
        custom
      )
      for (const opacity of [0.45, 0.76, 1]) {
        const actual = await state(theme, true, true, opacity)
        assert.equal(
          new Set(actual.map((surface) => surface.color)).size,
          1,
          `${name}: custom shell tints diverged`
        )
        for (const surface of actual)
          assert.ok(Math.abs(surface.alpha - Math.max(0.68, opacity)) < 0.01)
        count++
      }
    }
    await page.evaluate(() =>
      document.getElementById("app")!.style.removeProperty("--bg-base")
    )
    const toolbarPadding = await page.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>(
        ".shell-artwork-toolbar"
      )!
      toolbar.classList.add("app-topbar")
      let css = getComputedStyle(toolbar)
      const normal = [css.paddingTop, css.paddingBottom, css.marginBottom]
      toolbar.dataset.shellPlatform = "mac"
      css = getComputedStyle(toolbar)
      return {
        normal,
        mac: [css.paddingTop, css.paddingBottom, css.marginBottom],
      }
    })
    assert.deepEqual(toolbarPadding.normal, ["12px", "12px", "0px"])
    assert.deepEqual(toolbarPadding.mac, ["32px", "12px", "0px"])
    await page.evaluate(() => {
      const toolbar = document.querySelector(".shell-artwork-toolbar")!
      const button = document.createElement("button")
      button.className = "shell-control-secondary"
      button.textContent = "Synthetic shell action"
      toolbar.append(button)
    })
    const action = page.getByRole("button", { name: "Synthetic shell action" })
    const beforeHover = await action.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    )
    await action.hover()
    await page.waitForFunction(
      (before) =>
        getComputedStyle(document.querySelector(".shell-control-secondary")!)
          .backgroundColor !== before,
      beforeHover
    )
    await page.emulateMedia({ reducedMotion: "reduce" })
    assert.equal(
      await action.evaluate(
        (element) => getComputedStyle(element).transitionDuration
      ),
      "0s"
    )
    if (name === "chromium") {
      const session = await context.newCDPSession(page)
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
      })
      assert.equal(
        await page.evaluate(
          () => matchMedia("(prefers-reduced-transparency: reduce)").matches
        ),
        true
      )
      for (const surface of await state("dark", true, true, 0.45)) {
        assert.equal(surface.alpha, 1)
        assert.equal(surface.blur, "none")
      }
    } else {
      // Playwright has no WebKit reduced-transparency emulation. Exercise the
      // exact production media branch as unconditional rules in this profile.
      await page.addStyleTag({ content: reducedRules })
      for (const surface of await state("light", true, true, 0.45)) {
        assert.equal(surface.alpha, 1)
        assert.equal(surface.blur, "none")
      }
    }
    console.log(
      `${name}: ${count} production-theme/custom ready/off/opacity cases + toolbar padding/hover/reduced-motion + reduced-transparency ${name === "chromium" ? "media emulation" : "production branch"} passed`
    )
    await context.close()
  } finally {
    await browser.close()
  }
}
