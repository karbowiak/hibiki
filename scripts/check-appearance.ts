import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fixtureBuild, disposeFixture, fixtureFile, launchFixtureBrowser } from "./lib/browserFixtures"
import { chromium, webkit, type Page } from "playwright"
import { podcastFeedPath } from "../src/lib/podcastRoute"
import { artworkContrast } from "../src/lib/artworkTone"

// Real components and stores, disposable preferences and playback, no account I/O.
const root = resolve(import.meta.dir, "..")
const output = await fixtureBuild(["tests/fixtures/libraryLayout/index.html"], "windows")
const artifacts = resolve(root, ".tmp/appearance-checks")
let artworkGate: Promise<void> | null = null
async function checkPlaybackQuality(page: Page, name: string) {
  for (const [width, height, theme] of [[1940, 1214, "dark"], [1000, 760, "light"]] as const) {
    await page.setViewportSize({ width, height })
    await page.evaluate(({ theme }) => {
      ;(window as any).fixtureAppearance.apply({ theme })
      ;(window as any).fixtureAppearance.panel(null)
      ;(window as any).fixtureAppearance.lyricsPreview()
      ;(window as any).fixtureAppearance.trackInfo(true)
    }, { theme })
    const info = page.getByRole('button', { name: 'Track info', exact: true })
    const transport = page.getByRole('button', { name: 'Pause', exact: true }).or(page.getByRole('button', { name: 'Play', exact: true })).last()
    const before = await transport.boundingBox()
    const stars = page.locator('.player-track').getByRole('group', { name: /^Rating for / })
    assert.equal(await stars.count(), 1)
    const starBounds = await stars.boundingBox()
    const detailsBounds = await page.locator('.player-track').boundingBox()
    assert.ok(starBounds && detailsBounds && starBounds.x >= detailsBounds.x && starBounds.x + starBounds.width <= detailsBounds.x + detailsBounds.width, `${name}/${width}: stars leave bottom-left track details`)
    assert.equal(await page.locator('.player-center').getByRole('group', { name: /^Rating for / }).count(), 0)
    for (const [format, label] of [
      [{ codec: 'FLAC', bit_depth: 16, sample_rate: 44100, channels: 2 }, 'FLAC 16bit/44.1kHz'],
      [{ codec: 'FLAC', bit_depth: 24, sample_rate: 192000, channels: 2 }, 'FLAC 24bit/192kHz'],
      [{ codec: 'MP3', bit_depth: 32, sample_rate: 48000, channels: 2 }, 'MP3 48kHz'],
    ] as const) {
      await page.evaluate(value => (window as any).fixtureAppearance.playingFormat(value), format)
      await info.locator('span[title]').waitFor()
      assert.equal(await info.locator('span[title]').getAttribute('title'), label)
      const now = await transport.boundingBox()
      assert.ok(now && before && Math.abs(now.x - before.x) < 1, `${name}/${width}: quality text moved transport`)
    }
    await info.click()
    const panel = page.getByRole('dialog', { name: 'Track info', exact: true })
    await panel.getByText('Playing format', { exact: true }).waitFor()
    await panel.getByText('MP3 48kHz', { exact: true }).waitFor()
    const transition = panel.getByRole('region', { name: 'Next transition' })
    await transition.getByText('MixRamp overlap', { exact: true }).waitFor()
    await transition.getByText('15s before end', { exact: true }).waitFor()
    assert.equal(await transition.locator('dl > div').count(), 3)
    for (const row of await panel.locator('.track-info-section dl > div').all()) {
      assert.equal(await row.evaluate(element => getComputedStyle(element).display), 'grid')
      const label = await row.locator('dt').boundingBox()
      const value = await row.locator('dd').boundingBox()
      assert.ok(label && value && label.x + label.width <= value.x && Math.abs(label.y - value.y) < 2, `${name}/${width}: technical information lost label/value alignment`)
    }
    await transition.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifacts, `${name}-${width}-quality-format.png`) })
    await page.keyboard.press('Escape')
    assert.equal(await info.evaluate(e => e === document.activeElement), true)
  }
}
async function checkPlaybackDiagnostics(page: Page, name: string) {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).fixtureCopiedDiagnostics = text } } })
  })
  for (const [width, height, theme] of [[1940, 1214, "dark"], [1000, 760, "light"]] as const) {
    await page.setViewportSize({ width, height })
    await page.evaluate(({ theme }) => {
      ;(window as any).fixtureAppearance.apply({ theme })
      ;(window as any).fixtureAppearance.panel(null)
      ;(window as any).fixtureAppearance.lyricsPreview()
      ;(window as any).fixtureAppearance.playingFormat({ codec: "FLAC", bit_depth: 16, sample_rate: 44100, channels: 2 })
    }, { theme })
    const info = page.getByRole("button", { name: "Track info", exact: true })
    await info.click()
    const panel = page.getByRole("dialog", { name: "Track info", exact: true })
    const before = await page.evaluate(() => (window as any).fixtureDiagnostics.calls())
    await panel.getByRole("button", { name: "Playback", exact: true }).click()
    await panel.getByText("Device output", { exact: true }).waitFor()
    await panel.locator('.playback-history svg').first().waitFor()
    await panel.locator('.playback-history svg').nth(1).waitFor()
    assert.match(await panel.evaluate(element => getComputedStyle(element).backdropFilter), /blur\(18px\)/)
    assert.equal(await panel.getByText("FLAC 16bit/44.1kHz", { exact: true }).count(), 1)
    assert.equal(await panel.getByText("32-bit float · 96 kHz · 2 channels", { exact: true }).count(), 1)
    const bounds = await panel.boundingBox()
    assert.ok(bounds && bounds.x >= 8 && bounds.y >= 8 && bounds.x + bounds.width <= width - 7 && bounds.y + bounds.height <= height, `${name}: diagnostics leave viewport`)
    assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
    assert.ok(await page.evaluate(() => (window as any).fixtureDiagnostics.calls()) > before)
    await page.screenshot({ path: join(artifacts, `${name}-${width}-playback-diagnostics.png`) })
    await panel.getByRole("button", { name: "Copy diagnostics", exact: true }).click()
    await panel.getByRole("button", { name: "Copied", exact: true }).waitFor()
    const copied = await page.evaluate(() => JSON.parse((window as any).fixtureCopiedDiagnostics))
    assert.equal(copied.schema, 1); assert.equal(copied.playback.playbackId, 1)
    assert.ok(copied.samples.length <= 60)
    assert.ok(!/streamUrl|_providerData|X-Plex-Token|https?:/.test(JSON.stringify(copied)))
    await page.keyboard.press("Escape")
    assert.equal(await info.evaluate(e => e === document.activeElement), true)
    const stopped = await page.evaluate(() => (window as any).fixtureDiagnostics.calls())
    await page.waitForTimeout(700)
    assert.equal(await page.evaluate(() => (window as any).fixtureDiagnostics.calls()), stopped, `${name}: diagnostics kept polling after close`)
  }
}
async function checkTrackRowLayout(page: Page, name: string) {
  for (const [width, theme] of [[1440, "dark"], [1000, "light"]] as const) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(({ theme }) => {
      ;(window as any).fixtureAppearance.apply({ theme })
      ;(window as any).fixtureAppearance.panel(null)
    }, { theme })
    for (const path of ['/album/fixture-album', '/artist/fixture-artist', ...(process.argv.includes('--album-hover-only') ? ['/playlist/stress-0', '/collection/tracks'] : ['/playlist/fixture-playlist-0'])]) {
      await page.evaluate(path => (window as any).fixtureAppearance.route(path), path)
      const row = page.locator('.track-table tbody tr[data-track-index]').first()
      await row.waitFor({ timeout: 10000 }).catch(async error => { throw new Error(`${name}/${path}: ${await page.locator("main").innerText()} ${error}`) })
      // Long text must not change the fixed duration or any other column.
      await row.locator('td:nth-child(2) span.truncate').first().evaluate(e => {
        e.textContent = 'A very long song title '.repeat(20)
      })
      await page.mouse.move(1, 1)
      const heart = row.locator('.track-row-heart')
      if (await heart.count()) {
        await page.evaluate(() => (window as any).fixtureAppearance.liked('100000', true))
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.track-table tbody .track-row-heart')!).opacity === '1')
        assert.equal(await heart.getAttribute('aria-pressed'), 'true')
        await page.evaluate(() => (window as any).fixtureAppearance.liked('100000', false))
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.track-table tbody .track-row-heart')!).opacity === '0')
      }
      const bounds = () => row.evaluate(e => [...e.querySelectorAll('td')].map(cell => {
        const r = cell.getBoundingClientRect()
        return [r.x, r.y, r.width, r.height]
      }))
      const before = await bounds()
      const duration = row.locator('.track-row-duration')
      const time = await duration.textContent()
      await row.hover()
      assert.deepEqual(await bounds(), before, `${name}/${width}/${path}: hover moved columns`)
      assert.equal(await duration.textContent(), time)
      assert.equal(await duration.evaluate(e => getComputedStyle(e).visibility), 'visible')
      const actions = row.locator('.track-row-actions')
      await actions.getByRole('button', { name: /^Add .* to queue$/ }).focus()
      assert.deepEqual(await bounds(), before, `${name}/${path}: keyboard focus moved columns`)
      assert.equal(await actions.evaluate(e => getComputedStyle(e).position), 'static')
      const actionBounds = await actions.boundingBox()
      const titleCell = await row.locator('td:nth-child(2)').boundingBox()
      const titleLine = await row.locator('.track-row-title-line').boundingBox()
      assert.ok(actionBounds && titleCell && actionBounds.x >= titleCell.x && actionBounds.x + actionBounds.width <= titleCell.x + titleCell.width, `${name}/${path}: actions leave the title column`)
      if (path.startsWith('/album/') && !(await row.locator('.track-row-secondary-line').count())) {
        assert.ok(titleLine && actionBounds && Math.abs(actionBounds.y + actionBounds.height / 2 - titleLine.y - titleLine.height / 2) < 2, `${name}/${path}: compact album actions are not aligned with the title`)
      } else {
        assert.ok(titleLine && actionBounds && actionBounds.y > titleLine.y + titleLine.height / 2, `${name}/${path}: actions are not on the second line`)
      }
      const artistLine = row.locator('.track-row-artist')
      if (!path.startsWith('/album/') && await artistLine.count()) {
        const artist = await artistLine.boundingBox()
        assert.ok(artist && actionBounds && actionBounds.x >= artist.x + artist.width - 1, `${name}/${path}: actions obscure the artist name`)
      }
      const index = await duration.evaluate(e => [...e.parentElement!.children].indexOf(e))
      const right = await duration.boundingBox()
      const header = await page.locator('.track-table th').nth(index).boundingBox()
      assert.ok(right && header && Math.abs(right.x - header.x) < 1 && Math.abs(right.width - header.width) < 1)
      await page.screenshot({ path: join(artifacts, `${name}-${width}-${path.split('/')[1]}-track-row.png`) })
    }
  }
}
async function checkFinishingPolish(page: Page, name: string) {
  for (const [width, height, theme, textSize, docked] of [[1440, 900, "dark", 16, false], [1100, 850, "light", 20, true], [800, 760, "dark", 20, false]] as const) {
    await page.setViewportSize({ width, height })
    await page.evaluate(({ theme, textSize, docked }) => {
      ;(window as any).fixtureAppearance.apply({ theme, textSize })
      ;(window as any).fixtureAppearance.panel(docked ? "queue" : null, docked)
      ;(window as any).fixtureAppearance.route('/settings/appearance')
    }, { theme, textSize, docked })
    const settings = page.locator('.settings-main')
    await settings.waitFor()
    assert.equal(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `${name}/${width}: settings overflow their available column`)
    const settingsWidth = await page.locator('.settings-layout').evaluate(element => element.clientWidth)
    if (settingsWidth <= 760) assert.equal(await page.locator('.settings-navigation ul').evaluate(element => getComputedStyle(element).display), 'flex')
    assert.equal(await page.getByRole('group', { name: 'Theme', exact: true }).locator('[aria-pressed="true"]').count(), 1)
    await page.screenshot({ path: join(artifacts, `${name}-${width}-settings-polish.png`), animations: 'disabled' })
    await page.getByRole('button', { name: 'Create Playlist', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'Create playlist', exact: true })
    await create.waitFor()
    assert.equal(await create.getByRole('textbox', { name: 'Playlist name' }).evaluate(element => document.activeElement === element), true)
    await create.getByRole('textbox', { name: 'Playlist name' }).fill('A synthetic playlist name; never submitted')
    assert.equal(await create.getByRole('button', { name: 'Create', exact: true }).isEnabled(), true)
    await page.screenshot({ path: join(artifacts, `${name}-${width}-create-playlist-polish.png`), animations: 'disabled' })
    await create.getByRole('button', { name: 'Close create playlist', exact: true }).click()
    await create.waitFor({ state: 'detached' })
    for (const label of ['Sleep Timer', 'Guest DJ', 'Equalizer', 'Radio settings']) {
      if (label === 'Radio settings') await page.evaluate(() => (window as any).fixtureAppearance.radioPreview())
      await page.getByRole('button', { name: label, exact: true }).click()
      const popup = page.getByRole('dialog', { name: label, exact: true })
      await popup.waitFor()
      const bounds = await popup.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, `${name}/${width}/${label}: popover leaves the window`)
      assert.equal(await popup.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `${name}/${label}: popover content overflows`)
      if (label === 'Sleep Timer') {
        const duration = popup.getByRole('spinbutton', { name: 'Sleep timer duration in minutes' })
        await duration.fill('999')
        assert.equal(await popup.getByRole('button', { name: 'Set', exact: true }).isDisabled(), true)
        await duration.fill('25')
        assert.equal(await popup.getByRole('button', { name: 'Set', exact: true }).isEnabled(), true)
        await page.screenshot({ path: join(artifacts, `${name}-${width}-sleep-polish.png`), animations: 'disabled' })
      }
      await popup.getByRole('button', { name: /^Close / }).click()
      await popup.waitFor({ state: 'detached' })
    }
    for (const path of ['/collection/playlists', '/collection/albums', '/collection/artists', '/stations']) {
      await page.evaluate(value => (window as any).fixtureAppearance.route(value), path)
      await page.locator('.app-page-content h1').waitFor()
      if (path.endsWith('albums') || path.endsWith('artists')) {
        await page.locator('.media-card__rating').first().waitFor()
        assert.equal(await page.locator('.media-card__fallback').count() > 0, true)
      }
      if (path === '/stations') {
        await page.locator('.station-tile').first().waitFor()
        const title = page.locator('.station-tile__title').first()
        assert.equal(await title.evaluate(element => getComputedStyle(element).color), 'rgb(255, 255, 255)')
      }
      await page.screenshot({ path: join(artifacts, `${name}-${width}-${path.split('/').at(-1)}-polish.png`), animations: 'disabled' })
    }
  }
  await page.evaluate(() => {
    ;(window as any).fixtureAppearance.panel(null)
    ;(window as any).fixtureAppearance.apply({})
  })
}
async function checkFullscreenVisualizer(page: Page, name: string) {
  for (const [width, height, theme, textSize] of [[1440, 900, "dark", 16], [900, 720, "light", 20], [620, 620, "dark", 16]] as const) {
    await page.setViewportSize({ width, height })
    await page.evaluate(({ theme, textSize }) => {
      ;(window as any).fixtureAppearance.apply({ theme, textSize, background: true })
      ;(window as any).fixtureAppearance.route("/")
      ;(window as any).fixtureAppearance.panel("queue", true)
      ;(window as any).fixtureAppearance.visualizer("spectrum")
    }, { theme, textSize })
    await page.locator('.app-artwork-shell[data-artwork-background="ready"]').waitFor()
    const opener = page.getByRole("button", { name: "Open fullscreen visualizer", exact: true })
    await opener.click()
    const dialog = page.getByRole("dialog", { name: "Music visualization" })
    await dialog.waitFor()
    assert.equal(await dialog.evaluate(element => element.parentElement === document.body), true, `${name}: visualizer is trapped inside the filtered playbar`)
    assert.equal(await page.locator('#root').evaluate(element => element.hasAttribute('inert')), true)
    const playerAccent = await page.locator('[data-player-bar]').evaluate(element => getComputedStyle(element).getPropertyValue('--accent'))
    assert.equal(await dialog.evaluate(element => getComputedStyle(element).getPropertyValue('--accent')), playerAccent, `${name}: portalling lost the playing album palette`)
    await page.keyboard.press('?')
    const help = page.getByRole('dialog', { name: 'Keyboard Shortcuts', exact: true })
    await help.waitFor()
    assert.equal(await help.evaluate(element => element.parentElement === document.body && element.contains(document.activeElement)), true, `${name}: shortcut help is trapped behind the viewer`)
    assert.equal(await help.evaluate(element => element.matches(':modal') || Number(getComputedStyle(element).zIndex) > 500), true)
    await page.keyboard.press('Escape')
    await help.waitFor({ state: 'detached' })
    assert.equal(await dialog.evaluate(element => element === document.activeElement), true)
    for (const mode of ["Spectrum", "Oscilloscope", "Vu", "Starfield", "Milkdrop"]) {
      await dialog.getByRole("button", { name: new RegExp(`^${mode}$`, "i") }).click()
      const layout = await dialog.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const stage = element.querySelector('.fullscreen-visualizer-stage')!.getBoundingClientRect()
        const controls = element.querySelector('.fullscreen-visualizer-controls')!.getBoundingClientRect()
        const visibleControls = [...element.querySelectorAll<HTMLElement>('button, input')].filter(control => control.getClientRects().length > 0)
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
          stageHeight: stage.height, stageBottom: stage.bottom, controlsTop: controls.top,
          overflow: element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
          outOfBounds: visibleControls.some(control => { const r = control.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 1 || r.top < 0 || r.bottom > innerHeight + 1 }),
          background: getComputedStyle(element).backgroundColor }
      })
      assert.deepEqual([layout.x, layout.y, layout.width, layout.height], [0, 0, width, height], `${name}/${mode}: visualizer does not fill the viewport`)
      assert.equal(layout.overflow || layout.outOfBounds, false, `${name}/${mode}/${width}: controls overflow`)
      assert.ok(layout.stageHeight > height / 2 && layout.stageBottom <= layout.controlsTop + 1, `${name}/${mode}: canvas and controls overlap`)
      assert.equal(layout.background, "rgb(0, 0, 0)", `${name}: light theme leaked into the immersive stage`)
    }
    await page.screenshot({ path: join(artifacts, `${name}-${width}-fullscreen-visualizer.png`) })
    await dialog.getByRole('button', { name: /^spectrum$/i }).click()
    await page.setViewportSize({ width: width + 40, height: height + 40 })
    await page.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.fullscreen-visualizer-stage canvas')!
      return canvas.width === Math.round(canvas.clientWidth * devicePixelRatio)
        && canvas.height === Math.round(canvas.clientHeight * devicePixelRatio)
    })
    // The keyboard stays in the viewer, then returns to its trigger on close.
    await dialog.getByRole('button', { name: 'Close visualizer' }).focus()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await dialog.getByRole('button', { name: /^milkdrop$/i }).evaluate(element => element === document.activeElement), true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.locator('#root').evaluate(element => element.hasAttribute('inert')), false)
    assert.equal(await opener.evaluate(element => element === document.activeElement), true)
  }
  await page.evaluate(() => {
    ;(window as any).fixtureAppearance.panel(null)
    ;(window as any).fixtureAppearance.apply({})
  })
}
async function checkBackgroundSeparation(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(async () => {
    ;(window as any).fixtureAppearance.apply({})
    ;(window as any).fixtureAppearance.route("/search")
    await (window as any).fixtureArtwork.detailBackground("detail-mode.svg")
    ;(window as any).fixtureAppearance.route("/artist/fixture-artist")
  })
  await page.locator('.app-artwork-frame:not(.app-artwork-frame--retiring) .app-artwork-sharp').waitFor()
  await page.locator('.app-artwork-frame:not(.app-artwork-frame--retiring)[data-artwork-origin="detail"]').waitFor()
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('.app-artwork-frame:not(.app-artwork-frame--retiring) img')?.src.includes("detail-mode.svg"))
  let release!: () => void
  artworkGate = new Promise<void>(resolve => { release = resolve })
  try {
    await page.evaluate(() => {
      ;(window as any).fixtureArtwork.replace("mode-delayed.svg")
      ;(window as any).fixtureAppearance.route("/")
    })
    await page.locator('.app-artwork-shell[data-artwork-mode="global"]').waitFor()
    assert.equal(await page.locator('.app-artwork-sharp').count(), 0, `${name}: retained detail hero leaks onto Home while its image loads`)
    assert.ok(await page.locator('.app-artwork-frame[data-artwork-origin="detail"]').count() > 0, `${name}: delayed-image regression did not retain the prior detail frame`)
  } finally { release(); artworkGate = null }
  for (const path of ["/library", "/search", "/collection/playlists", "/stations", "/podcasts"]) {
    await page.evaluate(value => (window as any).fixtureAppearance.route(value), path)
    await page.locator('.app-artwork-shell[data-artwork-mode="global"]').waitFor()
    assert.equal(await page.locator('.app-artwork-sharp').count(), 0, `${name}/${path}: a general page has a sharp hero`)
    // Crossfades can retire a pixel node between Playwright resolving it and
    // reading its styles. Query from the persistent shell in the same JS turn.
    const blur = await page.locator('.app-artwork-shell').evaluate(shell => {
      const pixels = shell.querySelector('.app-artwork-pixels')
      return pixels ? getComputedStyle(pixels).filter : null
    })
    assert.match(blur ?? "", /blur\(28px\)/, `${name}/${path}: global artwork must stay blurred`)
  }
  await page.evaluate(() => (window as any).fixtureArtwork.detailBackground("cover.svg"))
  for (const path of ["/album/fixture-album", "/playlist/fixture-playlist-0"]) {
    await page.evaluate(value => (window as any).fixtureAppearance.route(value), path)
    await page.locator('.app-artwork-shell[data-artwork-mode="detail"]').waitFor()
    await page.locator('.app-artwork-frame:not(.app-artwork-frame--retiring) .app-artwork-sharp').waitFor()
  }
}
async function checkLyricsDesign(page: Page, name: string) {
  const settleDock = () => page.waitForFunction(() => {
    const dock = document.querySelector<HTMLElement>('.app-docked-panel')
    if (!dock?.parentElement) return false
    const r = dock.getBoundingClientRect(), wrapper = dock.parentElement.getBoundingClientRect()
    return Math.abs(r.width - wrapper.width) < 0.5 && r.right <= innerWidth + 0.5
  })
  for (const [width, height, theme, textSize] of [[1440, 900, "dark", 16], [1100, 850, "light", 20]] as const) {
    await page.setViewportSize({ width, height })
    await page.evaluate(({ theme, textSize }) => {
      ;(window as any).fixtureAppearance.apply({ theme, textSize })
      ;(window as any).fixtureAppearance.route("/album/fixture-album")
      ;(window as any).fixtureAppearance.panel("queue", true)
      ;(window as any).fixtureAppearance.lyricsPreview()
    }, { theme, textSize })
    await settleDock()
    const queueWidth = await page.locator('.app-docked-panel').evaluate(element => element.getBoundingClientRect().width)
    await page.getByRole("button", { name: "Lyrics", exact: true }).first().click()
    await settleDock()
    const active = page.locator('.lyrics-line[aria-current="true"]')
    await active.waitFor()
    const centered = () => page.waitForFunction(() => {
      const line = document.querySelector<HTMLElement>('.lyrics-line[aria-current="true"]')!
      const scroller = document.querySelector<HTMLElement>('.lyrics-scroll')!
      const r = scroller.getBoundingClientRect(), row = line.getBoundingClientRect()
      return Math.abs(row.top + row.height / 2 - r.top - r.height / 2) < 2
    })
    await centered()
    for (const position of [0, 84000, 42000]) {
      await page.evaluate(value => (window as any).fixtureAppearance.lyricsPreview(false, value), position)
      await centered()
    }
    const metrics = await page.locator('.lyrics-content').evaluate(element => ({
      overflow: element.scrollWidth > element.clientWidth,
      title: element.querySelector('.lyrics-track-title')?.textContent,
      mask: getComputedStyle(element.querySelector('.lyrics-scroll')!).maskImage,
    }))
    assert.equal(metrics.overflow, false, `${name}: lyrics overflow the dock`)
    assert.ok(metrics.title?.includes("Long Opening"), `${name}: playing song identity missing`)
    assert.notEqual(metrics.mask, "none", `${name}: lyrics scroll edge fades missing`)
    await page.screenshot({ path: join(artifacts, `${name}-${theme}-immersive-lyrics.png`) })
    const scrollBefore = await page.locator('.app-page-content').evaluate(element => element.scrollTop)
    await active.click()
    assert.equal(await page.locator('.app-page-content').evaluate(element => element.scrollTop), scrollBefore, `${name}: lyric seeking scrolls the album page`)
    await page.evaluate(() => (window as any).fixtureAppearance.lyricsPreview(true))
    assert.equal(await page.locator('.lyrics-line[aria-current="true"]').count(), 0)
    assert.equal(await page.getByRole("slider", { name: "Lyrics timing offset" }).count(), 0)
    assert.equal(await page.locator('.lyrics-line:enabled').count(), 0)
    await page.getByRole("button", { name: "Queue", exact: true }).first().click()
    await settleDock()
    assert.equal(await page.locator('.app-docked-panel').evaluate(element => element.getBoundingClientRect().width), queueWidth, `${name}: lyrics changed the saved queue width`)
  }
  await page.evaluate(() => {
    ;(window as any).fixtureAppearance.panel(null)
    ;(window as any).fixtureAppearance.lyricsPreview()
  })
}
async function checkOverlayMaterial(page: Page, browser: string) {
  await page.setViewportSize({ width: 1440, height: 850 })
  await page.evaluate(() => {
    ;(window as any).fixtureAppearance.apply({ theme: "dark", background: true })
    ;(window as any).fixtureAppearance.route("/artist/fixture-artist")
  })
  await page.locator('.app-artwork-shell[data-artwork-background="ready"]').waitFor()
  await page.keyboard.press("Control+k")
  const popup = page.getByRole("listbox", { name: "Search suggestions", exact: true })
  await popup.waitFor()
  assert.match(await popup.evaluate(element => getComputedStyle(element).backdropFilter), /blur\(18px\)/)
  assert.equal(await page.locator(".app-topbar").evaluate(element => getComputedStyle(element).backdropFilter), "none")
  // A real pixel check: computed blur alone passes even when an ancestor's
  // backdrop root prevents the dropdown from sampling the page underneath it.
  const clip = await popup.evaluate(element => {
    const r = element.getBoundingClientRect()
    const probe = document.createElement("div")
    probe.id = "overlay-blur-probe"
    Object.assign(probe.style, { position: "fixed", inset: "0", pointerEvents: "none",
      background: "repeating-linear-gradient(90deg, #000 0px, #000 4px, #fff 4px, #fff 8px)" })
    document.querySelector(".app-page-content")!.append(probe)
    const style = document.createElement("style")
    style.id = "overlay-blur-probe-style"
    style.textContent = ".discovery-search-popup > * { visibility: hidden !important; }"
    document.head.append(style)
    return { x: Math.ceil(r.left + 30), y: Math.ceil(r.top + 60), width: 200, height: 100 }
  })
  async function edgeEnergy() {
    const png = await page.screenshot({ clip })
    return page.evaluate(async base64 => {
      const image = new Image()
      image.src = `data:image/png;base64,${base64}`
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.width; canvas.height = image.height
      const ctx = canvas.getContext("2d")!
      ctx.drawImage(image, 0, 0)
      const data = ctx.getImageData(0, 0, image.width, image.height).data
      let energy = 0
      for (let y = 0; y < image.height; y++) for (let x = 1; x < image.width; x++) {
        const i = (y * image.width + x) * 4
        energy += Math.abs(data[i] - data[i - 4])
      }
      return energy / ((image.width - 1) * image.height)
    }, png.toString("base64"))
  }
  const blurred = await edgeEnergy()
  await popup.evaluate(element => {
    const style = (element as HTMLElement).style
    style.setProperty("backdrop-filter", "none", "important")
    style.setProperty("-webkit-backdrop-filter", "none", "important")
  })
  const sharp = await edgeEnergy()
  await popup.evaluate(element => {
    ;(element as HTMLElement).style.removeProperty("backdrop-filter")
    ;(element as HTMLElement).style.removeProperty("-webkit-backdrop-filter")
    document.getElementById("overlay-blur-probe")!.remove()
    document.getElementById("overlay-blur-probe-style")!.remove()
  })
  // Playwright's headless WebKit does not render backdrop blur even in a bare
  // HTML reproduction. Verify pixels in Chromium and the native Mac app; keep
  // WebKit's production-style, geometry and keyboard assertions here.
  if (browser === "chromium")
    assert.ok(sharp > 2 && blurred < sharp * 0.2, `${browser}: search backdrop not blurred (${blurred} vs ${sharp})`)
  await page.screenshot({ path: join(artifacts, `${browser}-search-glass.png`) })
  await page.keyboard.press("Escape")
  for (const [width, height, theme, textSize, debug] of [
    [1440, 850, "dark", 16, false], [800, 650, "light", 20, true],
  ] as const) {
    await page.setViewportSize({ width, height })
    await page.evaluate(({ theme, textSize, debug }) => {
      ;(window as any).fixtureAppearance.apply({ theme, textSize })
      ;(window as any).fixtureAppearance.trackInfo(debug)
    }, { theme, textSize, debug })
    const trigger = page.getByRole("button", { name: "Track info", exact: true })
    await trigger.click()
    const panel = page.getByRole("dialog", { name: "Track info", exact: true })
    await panel.waitFor()
    const layout = await panel.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const sections = [...element.querySelectorAll("dl")].map(dl => dl.getBoundingClientRect())
      const body = element.querySelector<HTMLElement>(".track-info-body")!
      const style = getComputedStyle(body)
      const contentWidth = body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        viewport: innerWidth, fullWidth: sections.every(s => Math.abs(s.width - contentWidth) < 1),
        overflow: element.scrollWidth > element.clientWidth,
        canScroll: element.scrollHeight > element.clientHeight }
    })
    assert.ok(layout.left >= 7 && layout.right <= layout.viewport - 7 && layout.top >= 7, `${browser}: track info outside window`)
    assert.equal(layout.fullWidth, true, `${browser}: track info reserves an empty column`)
    assert.equal(layout.overflow, false, `${browser}: track info scrolls horizontally`)
    if (debug) assert.equal(layout.canScroll, true, `${browser}: long info panel is not vertically scrollable`)
    await panel.getByRole("region", { name: "Next transition" }).waitFor()
    await page.screenshot({ path: join(artifacts, `${browser}-${width}-track-info.png`) })
    await page.keyboard.press("Escape")
    await panel.waitFor({ state: "detached" })
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
  }
  await page.evaluate(() => (window as any).fixtureAppearance.trackInfo(false))
}
async function checkBackgroundFraming(page: Page, name: string) {
  // A portrait's upper subject must survive real shell crops on all detail routes.
  await page.evaluate(async () => {
    ;(window as any).fixtureAppearance.route("/search")
    await (window as any).fixtureArtwork.focusBackground()
  })
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: 850 })
    for (const path of [
      "/artist/fixture-artist",
      "/album/fixture-album",
      "/playlist/fixture-playlist-0",
    ]) {
      await page.evaluate(
        (value) => (window as any).fixtureAppearance.route(value),
        path
      )
      const title = path.startsWith("/artist/")
        ? "The Midnight Ensemble and the City Orchestra"
        : path.startsWith("/album/")
          ? "Live at the Concert Hall: The Complete Deluxe Edition"
          : "An exceptionally long synthetic playlist title for gallery truncation"
      await page
        .getByRole("heading", { level: 1, name: title, exact: true })
        .waitFor()
      try {
        await page.waitForFunction(() => document.querySelector<HTMLImageElement>(
          ".app-artwork-frame:not(.app-artwork-frame--retiring) .app-artwork-sharp img"
        )?.src.endsWith("portrait.svg"), undefined, { timeout: 5000 })
      } catch (error) {
        const state = await page.evaluate(() => ({
          path: location.pathname,
          images: [...document.querySelectorAll<HTMLImageElement>('.app-artwork-background img')].map(i => ({src:i.src,complete:i.complete,width:i.naturalWidth})),
          background: document.querySelector('.app-artwork-shell')?.getAttribute('data-artwork-background'),
        }))
        throw new Error(`${name}/${width}/${path}: focus image not ready ${JSON.stringify(state)}`, { cause: error })
      }
      await page.waitForFunction(
        () => {
          const scroller = document.querySelector(
            "#layout-fixture main .app-page-content"
          )!
          scroller.scrollTop = 0
          return (
            document
              .querySelector(".media-detail-hero")!
              .getBoundingClientRect().top >= 0
          )
        },
        undefined,
        { timeout: 5000 }
      )
      const crop = await page.evaluate(() => {
        const hero = document
          .querySelector(".media-detail-hero")!
          .getBoundingClientRect()
        const sharp = document.querySelector<HTMLImageElement>(
          ".app-artwork-frame:not(.app-artwork-frame--retiring) .app-artwork-sharp img"
        )!
        const ambient = document.querySelector<HTMLImageElement>(
          ".app-artwork-frame:not(.app-artwork-frame--retiring) .app-artwork-ambient img"
        )!
        const rect = sharp.getBoundingClientRect()
        const ambientRect = ambient.getBoundingClientRect()
        return {
          subjectY: rect.top + (rect.height * 110) / 720,
          top: hero.top,
          bottom: hero.bottom,
          sharpFilter: getComputedStyle(sharp).filter,
          aligned: (["left", "top", "width", "height"] as const).every(
            (key) => Math.abs(rect[key] - ambientRect[key]) < 1
          ),
          coversWindow:
            rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1,
        }
      })
      assert.ok(
        crop.subjectY > crop.top + 30 && crop.subjectY < crop.bottom - 30,
        `${name}/${width}/${path}: upper subject cropped out ${JSON.stringify(crop)}`
      )
      assert.equal(crop.sharpFilter, "none")
      assert.equal(
        crop.aligned,
        true,
        `${name}: sharp/blur focal geometry differs ${JSON.stringify(crop)}`
      )
      assert.equal(
        crop.coversWindow,
        true,
        `${name}: image fitted to the hero instead of the client`
      )
      if (path.startsWith("/album/"))
        await page.screenshot({
          path: join(artifacts, `${name}-${width}-portrait-focus.png`),
        })
    }
  }
}

async function checkSearchOverlay(page: Page, browser: string) {
  for (const [width, height, theme, background] of [
    [1440, 850, "dark", true],
    [800, 650, "light", true],
    [1440, 850, "dark", false],
  ] as const) {
    await page.setViewportSize({ width, height })
    await page.evaluate(value => {
      ;(window as any).fixtureAppearance.apply(value)
      ;(window as any).setFixtureSidebarWidth(240)
    }, { theme, background })
    for (const path of ["/", "/library", "/album/fixture-album", "/playlist/fixture-playlist-0"]) {
      await page.evaluate(value => (window as any).fixtureAppearance.route(value), path)
      await page.locator("main h1").waitFor()
      if (background) await page.locator('.app-artwork-shell[data-artwork-background="ready"]').waitFor()
      await page.keyboard.press("Control+k")
      const popup = page.getByRole("listbox", { name: "Search suggestions", exact: true })
      await popup.waitFor()
      const overlap = await popup.evaluate(element => {
        const r = element.getBoundingClientRect()
        const misses: string[] = []
        for (const x of [r.left + 8, r.left + r.width / 2, r.right - 8]) {
          for (const y of [r.top + 8, r.top + r.height / 2, r.bottom - 8]) {
            const hit = document.elementFromPoint(x, y)
            if (!hit || !element.contains(hit)) misses.push(hit?.className?.toString() ?? "nothing")
          }
        }
        const pane = element.closest(".app-page")!.getBoundingClientRect()
        return { misses, bottom: r.bottom, paneBottom: pane.bottom }
      })
      assert.deepEqual(overlap.misses, [], `${browser}/${width}/${path}: page content covers search dropdown`)
      assert.ok(overlap.bottom <= overlap.paneBottom - 11, `${browser}/${width}/${path}: search dropdown extends under the playbar`)
      if (path === "/") await page.screenshot({ path: join(artifacts, `${browser}-${width}-${theme}-${background}-search-overlay.png`) })
      await page.keyboard.press("Escape")
      await popup.waitFor({ state: "detached" })
    }
  }
}
await mkdir(artifacts, { recursive: true })
const previousPlatform = process.env.TAURI_ENV_PLATFORM
// Browser fixtures exercise Tauri's supported HTTP image transport; native Mac is reviewed separately.
process.env.TAURI_ENV_PLATFORM = "windows"
const fallbackFont = await Bun.file(
  resolve(
    root,
    "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"
  )
).bytes()
let server: ReturnType<typeof Bun.serve> | undefined
try {

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.includes("mode-delayed")) await artworkGate
      if (path === "/synthetic-artwork/portrait.svg")
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720"><rect width="480" height="720" fill="#202030"/><rect x="180" y="50" width="120" height="120" fill="#be7855"/><rect x="160" y="500" width="160" height="150" fill="#aaa"/></svg>',
          { headers: { "Content-Type": "image/svg+xml" } }
        )
      if (path.startsWith("/synthetic-artwork/"))
        return new Response(
          `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="${path.includes("replacement") ? "#0891b2" : path.includes("next") ? "#f97316" : "#7c3aed"}"/></svg>`,
          { headers: { "Content-Type": "image/svg+xml" } }
        )
      return fixtureFile(output,path)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ] as const) {
    if (process.argv.includes("--webkit-only") && name !== "webkit") continue
    const browser = await launchFixtureBrowser(type)
    try {
      const context = await browser.newContext()
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin) return route.continue()
        if (url.hostname === "image.localhost") {
          const src = url.searchParams.get("src")
          if (src && new URL(src).origin === origin) {
            const response = await fetch(src)
            return route.fulfill({
              status: response.status,
              headers: {
                "Content-Type": "image/svg+xml",
                "Access-Control-Allow-Origin": "*",
              },
              body: Buffer.from(await response.arrayBuffer()),
            })
          }
          return route.abort()
        }
        if (url.hostname === "encore.scdn.co" && /\.woff2?$/.test(url.pathname))
          return route.fulfill({
            body: Buffer.from(fallbackFont),
            contentType: "font/woff2",
          })
        return route.abort()
      })
      const page = await context.newPage()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(
        `${origin}/tests/fixtures/libraryLayout/index.html?appearance=1&player=1&discovery=1${process.argv.includes("--album-hover-only") ? "&virtual=1" : ""}`
      )
      await page.waitForFunction(() => (window as any).visualFixtureReady)
      if (process.argv.includes('--playback-info-only')) {
        await checkPlaybackQuality(page, name)
        await checkPlaybackDiagnostics(page, name)
        assert.deepEqual(errors, [], `${name}: renderer errors`)
        console.log(`${name}: track/diagnostics layout, bounded telemetry, copy redaction and teardown passed`)
        continue
      }
      if (process.argv.includes('--quality-only')) {
        await checkPlaybackQuality(page, name)
        assert.deepEqual(errors, [], `${name}: renderer errors`)
        console.log(`${name}: active source format, stable playback controls and track info passed`)
        continue
      }
      if (process.argv.includes('--album-hover-only')) {
        await checkTrackRowLayout(page, name)
        assert.deepEqual(errors, [], `${name}: renderer errors`)
        console.log(`${name}: shared album, artist, playlist and liked-song rows retain duration and fixed geometry`)
        continue
      }
      if (process.argv.includes('--finishing-polish-only')) {
        await checkFinishingPolish(page, name)
        await checkFullscreenVisualizer(page, name)
        assert.deepEqual(errors, [], `${name}: renderer errors`)
        console.log(`${name}: responsive settings, collection cards, creation, playback popovers and keyboard help passed`)
        continue
      }
      if (process.argv.includes("--visualizer-only")) {
        await checkFullscreenVisualizer(page, name)
        assert.deepEqual(errors, [], `${name}: renderer errors`)
        console.log(`${name}: fullscreen visualization sizing, modes, palette, resizing and focus passed`)
        continue
      }
      if (process.argv.includes("--background-lyrics-only")) {
        await checkBackgroundSeparation(page, name)
        await checkLyricsDesign(page, name)
        assert.deepEqual(errors, [], `${name}: renderer errors`)
        console.log(`${name}: global/detail background separation and immersive lyrics passed`)
        continue
      }
      if (process.argv.includes("--overlay-material-only")) {
        await checkOverlayMaterial(page, name)
        assert.deepEqual(errors, [], `${name}: renderer errors`)
        console.log(`${name}: shared glass styles and responsive track info passed${name === "chromium" ? " (pixel blur verified)" : ""}`)
        continue
      }
      if (process.argv.includes("--background-focus-only")) {
        await checkBackgroundFraming(page, name)
        assert.deepEqual(errors, [], `${name}: renderer errors`)
        console.log(`${name}: full-window fitting, focal crops and sharp/blur alignment passed`)
        continue
      }
      await checkSearchOverlay(page, name)
      if (process.argv.includes("--search-overlay-only")) {
        assert.deepEqual(errors, [], `${name}: renderer errors`)
        console.log(`${name}: search overlay stays above content and clear of the playbar across routes, themes and widths`)
        continue
      }
      await checkFullscreenVisualizer(page, name)
      await checkTrackRowLayout(page, name)
      await checkFinishingPolish(page, name)
      await checkOverlayMaterial(page, name)
      await checkBackgroundSeparation(page, name)
      await checkLyricsDesign(page, name)
      for (const scenario of [
        {
          width: 1440,
          sidebar: 240,
          font: "circular",
          cardSize: 160,
          theme: "dark",
          compact: false,
          custom: false,
          textSize: 16,
        },
        {
          width: 800,
          sidebar: 320,
          font: "jetbrains-mono",
          cardSize: 280,
          theme: "light",
          compact: true,
          custom: false,
          textSize: 18,
        },
        {
          width: 1100,
          sidebar: 240,
          font: "montserrat",
          cardSize: 140,
          theme: "dark",
          compact: false,
          custom: true,
          textSize: 16,
        },
      ]) {
        const slug = `${name}-${scenario.width}-${scenario.font}-${scenario.theme}`
        await page.setViewportSize({ width: scenario.width, height: 850 })
        await page.evaluate((value) => {
          ;(window as any).fixtureAppearance.apply(value)
          ;(window as any).setFixtureSidebarWidth(value.sidebar)
        }, scenario)
        await page.evaluate(() => document.fonts.ready)
        for (const route of [
          "/search",
          "/collection/playlists",
          "/artist/fixture-artist",
          "/album/fixture-album",
          "/playlist/fixture-playlist-0",
          "/podcasts",
          "/internet-radio",
          podcastFeedPath("https://synthetic.invalid/music.xml")!,
        ]) {
          await page.evaluate(
            (path) => (window as any).fixtureAppearance.route(path),
            route
          )
          await page.locator("main h1").waitFor()
          await page
            .locator("#layout-fixture main .overflow-auto")
            .evaluate((element) => {
              element.scrollTop = 0
            })
          await page.waitForTimeout(350) // CSS palette/layout transitions must settle.
          const metrics = await page.evaluate(() => {
            const main = document.querySelector<HTMLElement>(
              "#layout-fixture main"
            )!
            const scroller = main.querySelector<HTMLElement>(".overflow-auto")!
            const title = main.querySelector<HTMLElement>("h1")!
            const r = title.getBoundingClientRect()
            const family = getComputedStyle(document.body).fontFamily
            const rowTitle = main.querySelector<HTMLElement>(
              "tbody tr:nth-child(2) .track-row-title-line > .truncate, section .group span.truncate"
            )
            return {
              overflow: scroller.scrollWidth - scroller.clientWidth,
              documentOverflow:
                document.documentElement.scrollWidth - innerWidth,
              titleOverflow: title.scrollWidth - title.clientWidth,
              titleWidth: r.width,
              family,
              rowColor: rowTitle ? getComputedStyle(rowTitle).color : null,
              toolbarHeights: [...document.querySelectorAll<HTMLElement>(".app-topbar .topbar-control, .app-topbar .topbar-search")].map(e => e.getBoundingClientRect().height),
            }
          })
          assert.ok(metrics.toolbarHeights.length > 4 && Math.max(...metrics.toolbarHeights) - Math.min(...metrics.toolbarHeights) < 1, `${slug}: toolbar control heights differ ${metrics.toolbarHeights}`)
          if (metrics.overflow > 1) {
            await page.screenshot({
              path: join(
                artifacts,
                `${slug}-${route.split("/")[1]}-overflow.png`
              ),
            })
            console.log(
              await page.locator("main").evaluate((main) => {
                const r = main.getBoundingClientRect()
                return [...main.querySelectorAll("*")]
                  .filter(
                    (e) =>
                      e.getBoundingClientRect().right > r.right + 1 &&
                      e.getBoundingClientRect().width > 0
                  )
                  .slice(0, 12)
                  .map((e) => ({
                    tag: e.tagName,
                    class: e.className,
                    text: e.textContent?.slice(0, 80),
                    right: e.getBoundingClientRect().right,
                  }))
              })
            )
          }
          assert.ok(
            metrics.overflow <= 1 && metrics.documentOverflow <= 1,
            `${slug}/${route}: page overflow ${JSON.stringify(metrics)}`
          )
          assert.ok(
            metrics.titleWidth >= 160 && metrics.titleOverflow <= 1,
            `${slug}/${route}: heading clipped`
          )
          if (scenario.font === "jetbrains-mono")
            assert.ok(
              metrics.family.includes("JetBrains"),
              `${slug}: selected font missing`
            )
          if (route.startsWith("/album") && scenario.theme === "light")
            assert.equal(
              metrics.rowColor,
              "rgb(13, 13, 13)",
              `${slug}: album track ignores light palette`
            )
          await page.screenshot({
            path: join(artifacts, `${slug}-${route.split("/")[1]}.png`),
          })
          if (route === "/podcasts" || route === "/internet-radio") {
            const card = page.locator(".broadcast-card").first()
            const title = await card.locator(".media-card__title").innerText()
            await card.locator(".media-card__primary").click({ button: "right" })
            const menu = page.getByRole("dialog", { name: `${title} actions`, exact: true })
            await menu.waitFor()
            assert.ok(await menu.getByRole("button").count() >= 1, `${slug}: public card actions missing`)
            await page.keyboard.press("Escape")
            await menu.waitFor({ state: "detached" })
            await card.locator(".media-card__primary").focus()
            await page.keyboard.press("Shift+F10")
            await menu.waitFor()
            await page.keyboard.press("Control+k")
            await menu.waitFor({ state: "detached" })
            assert.equal(await page.getByRole("combobox", { name: "Search your music library" }).evaluate(element => element === document.activeElement), true, `${slug}: search failed from public card menu`)
            await page.keyboard.press("Escape")
          }
          if (route.startsWith("/artist") || route.startsWith("/album")) {
            const sharp = page.locator(
              ".app-artwork-frame:not(.app-artwork-frame--retiring) .app-artwork-sharp"
            )
            assert.equal(
              await sharp
                .locator("img")
                .evaluate((element) => getComputedStyle(element).filter),
              "none",
              `${slug}/${route}: hero artwork must remain sharp`
            )
            const geometry = () =>
              page.evaluate(() => {
                const hero = document
                  .querySelector(".media-detail-hero")!
                  .getBoundingClientRect()
                const band = document.querySelector<HTMLElement>(
                  ".app-artwork-frame:not(.app-artwork-frame--retiring) .app-artwork-sharp"
                )!
                const rect = band.getBoundingClientRect()
                const clip =
                  parseFloat(band.style.clipPath.split(" ")[2] ?? "0") || 0
                const ambient = document
                  .querySelector(
                    ".app-artwork-frame:not(.app-artwork-frame--retiring) .app-artwork-ambient"
                  )!
                  .getBoundingClientRect()
                return {
                  seam: rect.bottom - clip - Math.min(innerHeight, hero.bottom),
                  left: rect.left,
                  width: rect.width - innerWidth,
                  ambientTop: ambient.top,
                  ambientHeight: ambient.height - innerHeight,
                }
              })
            for (const amount of [0, 120]) {
              await page
                .locator("#layout-fixture main .overflow-auto")
                .evaluate((element, value) => {
                  element.scrollTop = value
                }, amount)
              await page.waitForTimeout(100)
              const aligned = await geometry()
              assert.ok(
                Object.values(aligned).every((value) => Math.abs(value) <= 1),
                `${slug}/${route}: artwork crop/seam is not aligned ${JSON.stringify(aligned)}`
              )
            }
            await page
              .locator("#layout-fixture main .overflow-auto")
              .evaluate((element) => {
                element.scrollTop = 0
              })
            await page.evaluate(() =>
              (window as any).fixtureAppearance.resetInteractions()
            )
            const play = page.getByRole("button", {
              name: "Play A Long Opening Track Title for the Midnight Ensemble",
              exact: true,
            })
            await play.focus()
            await page.keyboard.press("Enter")
            await page.keyboard.press("Space")
            const calls = await page.evaluate(() =>
              (window as any).fixtureAppearance.interactions()
            )
            assert.deepEqual(
              calls.map((call: any) => call.action),
              ["play", "play"],
              `${slug}/${route}: keyboard plays exactly once`
            )
            const queue = page.getByRole("button", {
              name: "Add A Long Opening Track Title for the Midnight Ensemble to queue",
              exact: true,
            })
            await queue.focus()
            await page.waitForTimeout(250)
            assert.equal(
              await queue.evaluate(
                (element) => getComputedStyle(element).opacity
              ),
              "1",
              `${slug}/${route}: focused action hidden`
            )
            await page.keyboard.press("Enter")
            assert.equal(
              (
                await page.evaluate(() =>
                  (window as any).fixtureAppearance.interactions()
                )
              ).at(-1).action,
              "queue"
            )
            const opener = page.getByRole("button", {
              name: /^Edit .+ artwork sources$/,
            })
            await opener.focus()
            await page.waitForFunction(
              () =>
                document.activeElement?.classList.contains(
                  "artwork-edit-trigger"
                ) && getComputedStyle(document.activeElement).opacity === "1"
            )
            assert.equal(
              await opener.evaluate(
                (element) => getComputedStyle(element).opacity
              ),
              "1",
              `${slug}: focused edit pen hidden`
            )
            await opener.click()
            const dialog = page.getByRole("dialog", { name: "Choose artwork" })
            await dialog.waitFor()
            const bounds = await dialog.evaluate((element) => {
              const r = element.getBoundingClientRect()
              return {
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
                overflow: element.scrollWidth - element.clientWidth,
              }
            })
            assert.ok(
              bounds.left >= 0 &&
                bounds.right <= scenario.width + 1 &&
                bounds.top >= 0 &&
                bounds.bottom <= 851 &&
                bounds.overflow <= 1,
              `${slug}: artwork dialog clipped ${JSON.stringify(bounds)}`
            )
            await page.screenshot({
              path: join(
                artifacts,
                `${slug}-${route.split("/")[1]}-artwork.png`
              ),
            })
            await page.keyboard.press("Escape")
            await dialog.waitFor({ state: "detached" })
            assert.equal(
              await opener.evaluate(
                (element) => element === document.activeElement
              ),
              true,
              `${slug}: artwork focus not restored`
            )
          }
        }
      }
      // A wide pinned panel and narrow overlay both remain readable and independent.
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.evaluate(() => {
        ;(window as any).fixtureAppearance.apply({
          font: "jetbrains-mono",
          custom: true,
        })
        ;(window as any).setFixtureSidebarWidth(240)
        ;(window as any).fixtureAppearance.route("/search")
      })
      for (const panel of ["queue", "lyrics"] as const) {
        await page.evaluate(
          (value) => (window as any).fixtureAppearance.panel(value, true),
          panel
        )
        const close = page.getByRole("button", {
          name: `Close ${panel}`,
          exact: true,
        })
        await close.waitFor()
        await page.waitForTimeout(350)
        const region = close.locator(
          "xpath=ancestor::div[contains(@class,'relative')][1]"
        )
        const alignment = await page.evaluate(() => {
          const toolbar = document.querySelector(".app-topbar")!.getBoundingClientRect()
          const panel = document.querySelector(".app-docked-header")!.getBoundingClientRect()
          const dock = document.querySelector(".app-docked-panel")!
          const nav = document.querySelector(".app-sidebar")!
          return { bottom: Math.abs(toolbar.bottom - panel.bottom), tint: getComputedStyle(dock).backgroundColor === getComputedStyle(nav).backgroundColor }
        })
        assert.ok(alignment.bottom <= 1 && alignment.tint, `${name}/${panel}: docked header or tint differs from the toolbar/sidebar ${JSON.stringify(alignment)}`)
        const handle = region.locator(".cursor-ew-resize").first()
        const box = await handle.boundingBox()
        const beforeWidth = await region.evaluate(element => element.getBoundingClientRect().width)
        assert.ok(box, `${name}/${panel}: resize handle missing`)
        await page.mouse.move(box.x + 2, box.y + 50)
        await page.mouse.down()
        await page.mouse.move(box.x - 150, box.y + 50)
        await page.mouse.up()
        await page.waitForTimeout(350)
        const width = await region.evaluate(
          (element) => element.getBoundingClientRect().width
        )
        assert.ok(
          Math.abs(width - Math.min(600, beforeWidth + 152)) <= 1,
          `${name}/${panel}: resize failed (${width})`
        )
        await page.screenshot({
          path: join(artifacts, `${name}-${panel}-pinned-resized.png`),
        })
        if (panel === "queue") {
          const play = page.getByRole("button", {
            name: "Play Synthetic track 2",
            exact: true,
          })
          await play.focus()
          await page.keyboard.press("Space")
          assert.equal(
            (
              await page.evaluate(() =>
                (window as any).fixtureAppearance.interactions()
              )
            ).at(-1).action,
            "jump"
          )
        } else {
          for (const [mode, text] of [
            ["idle", "Play a track to see its lyrics"],
            ["loading", "Loading lyrics…"],
            ["empty", "No lyrics available"],
          ]) {
            await page.evaluate(
              (value) => (window as any).fixtureAppearance.lyrics(value),
              mode
            )
            await page.getByRole("status").filter({ hasText: text }).waitFor()
          }
          await page.evaluate(() =>
            (window as any).fixtureAppearance.lyrics("ready")
          )
          await page
            .getByRole("button", { name: /^Seek to Synthetic lyric/ })
            .click()
          assert.equal(
            (
              await page.evaluate(() =>
                (window as any).fixtureAppearance.interactions()
              )
            ).at(-1).action,
            "seek"
          )
        }
        await close.click()
        await page.waitForTimeout(350)
        assert.equal(
          await close.count(),
          0,
          `${name}/${panel}: closed controls accessible`
        )
      }
      // Hold actual provider/feed responses to inspect initial loading shapes.
      for (const width of [1440, 800]) {
        await page.setViewportSize({ width, height: 850 })
        await page.evaluate(value => {
          ;(window as any).fixtureAppearance.apply({ theme: value === 800 ? "light" : "dark", cardSize: value === 800 ? 220 : 160 })
          ;(window as any).setFixtureSidebarWidth(240)
        }, width)
        for (const [path, kind] of [
          ["/artist/fixture-artist", "artist"],
          ["/album/fixture-album", "album"],
          [podcastFeedPath("https://synthetic.invalid/music.xml")!, "podcast"],
          ["/podcasts", "cards"],
          ["/internet-radio", "cards"],
          ["/playlist/fixture-playlist-0", "table"],
        ]) {
          await page.evaluate(() => (window as any).fixtureAppearance.route("/search"))
          await page.locator("main h1").waitFor()
          await page.evaluate(() => (window as any).fixtureLoading.hold(true))
          await page.evaluate(value => (window as any).fixtureAppearance.route(value), path)
          const placeholder = page.locator("main .skeleton-shimmer").first()
          await placeholder.waitFor()
          await page.waitForTimeout(350)
          const before = await page.locator("main").evaluate(main => {
            const scroller = main.querySelector<HTMLElement>(".overflow-auto")!
            const hero = main.querySelector<HTMLElement>(".media-detail-hero")?.getBoundingClientRect()
            return { overflow: scroller.scrollWidth - scroller.clientWidth, heroWidth: hero?.width, heroLeft: hero?.left, fakeControls: main.querySelectorAll("[data-page-loading] button, [data-page-loading] a").length }
          })
          assert.ok(before.overflow <= 1, `${name}/${width}/${kind}: loading page overflows`)
          assert.equal(before.fakeControls, 0, `${name}/${width}/${kind}: skeleton has usable fake controls`)
          await page.emulateMedia({ reducedMotion: "reduce" })
          assert.equal(await placeholder.evaluate(element => getComputedStyle(element, "::after").animationName), "none", `${name}/${kind}: loading ignores reduced motion`)
          await page.emulateMedia({ reducedMotion: "no-preference" })
          await page.screenshot({ path: join(artifacts, `${name}-${width}-loading-${kind}-${path.split("/")[1]}.png`) })
          await page.evaluate(() => (window as any).fixtureLoading.release())
          await page.locator("main .skeleton-shimmer").first().waitFor({ state: "detached" })
          if (before.heroWidth) {
            const after = await page.locator("main .media-detail-hero").evaluate(element => element.getBoundingClientRect().toJSON())
            assert.equal(after.width, before.heroWidth, `${name}/${kind}: hero width jumps on load`)
            assert.equal(after.left, before.heroLeft, `${name}/${kind}: hero gutter jumps on load`)
          }
        }
      }
      // Real pointer capture and hit testing must deliver one drop without playback/navigation.
      await page.setViewportSize({ width: 1440, height: 850 })
      await page.evaluate(() => {
        ;(window as any).fixtureAppearance.apply({})
        ;(window as any).fixtureAppearance.route("/search")
        ;(window as any).fixtureAppearance.resetInteractions()
      })
      const source = page.locator('section[aria-label="Jump back in"] .media-card__primary').first()
      const dropTarget = page.locator('[data-playlist-drop-target="fixture-playlist-0"] > a')
      await source.waitFor()
      const sourceBox = await source.boundingBox(), dropBox = await dropTarget.boundingBox()
      assert.ok(sourceBox && dropBox, `${name}: source or playlist drop target missing`)
      await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(dropBox.x + dropBox.width / 2, dropBox.y + dropBox.height / 2)
      await page.mouse.up()
      await page.waitForFunction(() => (window as any).fixturePlaylistDrops().length === 1)
      assert.deepEqual(await page.evaluate(() => (window as any).fixturePlaylistDrops()[0]), { id: "fixture-playlist-0", ids: ["recent-artist-0"] }, `${name}: pointer drop did not preserve the source identity`)
      assert.equal(await page.locator("main h1").innerText(), "Search", `${name}: drop navigated instead of adding`)
      assert.equal((await page.evaluate(() => (window as any).fixtureAppearance.interactions())).length, 0, `${name}: drag caused playback`)
      await page.setViewportSize({ width: 1440, height: 900 })
      // Real shell: stable pool, full-window pixels, palette contrast and image transitions.
      await page.evaluate(() => {
        ;(window as any).fixtureAppearance.panel(null)
        ;(window as any).fixtureAppearance.apply({})
        ;(window as any).fixtureAppearance.route("/search")
      })
      const active = page.locator(
        ".app-artwork-frame:not(.app-artwork-frame--retiring)"
      )
      await active.waitFor()
      await page.waitForTimeout(700)
      const firstSource = await active
        .locator("img")
        .first()
        .getAttribute("src")
      await page
        .getByRole("combobox", { name: "Search your music library" })
        .fill("synthetic")
      await page.waitForTimeout(300)
      assert.equal(
        await active.locator("img").first().getAttribute("src"),
        firstSource,
        `${name}: typing rotates artwork`
      )
      await page
        .getByRole("combobox", { name: "Search your music library" })
        .fill("")
      for (const settings of [
        { theme: "dark" },
        { theme: "light" },
        { theme: "dark", custom: true },
      ]) {
        await page.evaluate(
          (value) => (window as any).fixtureAppearance.apply(value),
          settings
        )
        await page.waitForTimeout(550)
        const colors = await page.evaluate(() => {
          const shell =
            document.querySelector<HTMLElement>(".app-artwork-shell")!
          const style = getComputedStyle(shell)
          const rgb = (value: string) => {
            const canvas = document.createElement("canvas")
            canvas.width = canvas.height = 1
            const context = canvas.getContext("2d")!
            context.fillStyle = value
            context.fillRect(0, 0, 1, 1)
            return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
          }
          const play = document.querySelector<HTMLElement>(
            ".app-playbar .shell-control-primary"
          )!
          const ps = getComputedStyle(play)
          return {
            text: rgb(style.getPropertyValue("--artwork-accent-text")),
            base: rgb(style.getPropertyValue("--bg-base")),
            ink: rgb(ps.color),
            primary: rgb(ps.backgroundColor),
            bars: [
              ...document.querySelectorAll<HTMLElement>(
                ".shell-artwork-surface"
              ),
            ].map((e) => getComputedStyle(e).backgroundColor),
            rect: document
              .querySelector(".app-artwork-background")!
              .getBoundingClientRect()
              .toJSON(),
          }
        })
        assert.ok(
          artworkContrast(colors.text as any, colors.base as any) >= 6.99,
          `${name}: artwork text lacks contrast`
        )
        assert.ok(
          artworkContrast(colors.ink as any, colors.primary as any) >= 4.5,
          `${name}: play button lacks contrast`
        )
        assert.equal(
          new Set(colors.bars).size,
          1,
          `${name}: shell tints differ`
        )
        assert.ok(
          colors.rect.width === 1440 &&
            colors.rect.height === 900 &&
            colors.rect.x === 0 &&
            colors.rect.y === 0,
          `${name}: backdrop excludes part of the app`
        )
      }
      const stablePlayback = await page
        .locator(".playback-palette")
        .evaluate((e) =>
          getComputedStyle(e).getPropertyValue("--artwork-primary")
        )
      const stableCreate = await page
        .getByRole("button", { name: "Create Playlist", exact: true })
        .evaluate((e) =>
          JSON.stringify({
            background: getComputedStyle(e).backgroundColor,
            foreground: getComputedStyle(e).color,
            icon: getComputedStyle(e.querySelector(".sidebar-create-icon")!).color,
          })
        )
      await page.evaluate(() =>
        (window as any).fixtureArtwork.replace("replacement.svg")
      )
      await page.waitForFunction(() =>
        document
          .querySelector<HTMLImageElement>(
            ".app-artwork-frame:not(.app-artwork-frame--retiring) img"
          )
          ?.src.includes("replacement.svg")
      )
      const layers = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".app-artwork-frame")].map(
          (e) => ({
            old: e.classList.contains("app-artwork-frame--retiring"),
            opacity: Number(getComputedStyle(e).opacity),
            animation: getComputedStyle(e).animationName,
          })
        )
      )
      assert.equal(
        layers.length,
        2,
        `${name}: prior artwork disappears before image fade`
      )
      assert.equal(
        layers.find((e) => e.old)?.opacity,
        1,
        `${name}: transition fades through empty background`
      )
      assert.equal(layers.find((e) => !e.old)?.animation, "artwork-fade-in")
      await page.waitForTimeout(700)
      assert.equal(await page.locator(".app-artwork-frame").count(), 1)
      await page.screenshot({
        path: join(artifacts, `${name}-artwork-shell.png`),
      })
      assert.equal(
        await page
          .locator(".playback-palette")
          .evaluate((e) =>
            getComputedStyle(e).getPropertyValue("--artwork-primary")
          ),
        stablePlayback,
        `${name}: page changed the playing album palette`
      )
      assert.equal(
        await page
          .getByRole("button", { name: "Create Playlist", exact: true })
          .evaluate((e) => JSON.stringify({
            background: getComputedStyle(e).backgroundColor,
            foreground: getComputedStyle(e).color,
            icon: getComputedStyle(e.querySelector(".sidebar-create-icon")!).color,
          })),
        stableCreate,
        `${name}: page changed Create Playlist color`
      )
      assert.notEqual(
        await page
          .locator(".app-artwork-shell")
          .evaluate((e) =>
            getComputedStyle(e).getPropertyValue("--artwork-primary")
          ),
        stablePlayback,
        `${name}: fixture did not exercise different page and playback palettes`
      )
      await page.evaluate(() => (window as any).fixtureArtwork.multiple())
      await page
        .getByRole("button", { name: "Next background image", exact: true })
        .click()
      await page.waitForFunction(() =>
        document
          .querySelector<HTMLImageElement>(
            ".app-artwork-frame:not(.app-artwork-frame--retiring) img"
          )
          ?.src.includes("next.svg")
      )
      assert.equal(
        await page
          .locator(".playback-palette")
          .evaluate((e) =>
            getComputedStyle(e).getPropertyValue("--artwork-primary")
          ),
        stablePlayback
      )
      await page
        .getByRole("button", {
          name: "Resume background rotation",
          exact: true,
        })
        .click()
      await page
        .getByRole("button", { name: "Pause background rotation", exact: true })
        .click()
      await page.evaluate(() =>
        (window as any).fixtureAppearance.route("/library")
      )
      await page.keyboard.press("Control+k")
      const searchBox = page.getByRole("combobox", {
        name: "Search your music library",
      })
      await page.waitForFunction(
        () =>
          document.querySelector('[role="combobox"]') === document.activeElement
      )
      assert.equal(await searchBox.getAttribute("aria-expanded"), "true")
      await page.keyboard.press("Escape")
      const menuCard = page.locator("main .media-card__primary").first()
      await menuCard.click({ button: "right" })
      await page.getByRole("dialog", { name: / actions$/ }).waitFor()
      await page.keyboard.press("Control+k")
      await page.waitForFunction(
        () =>
          document.querySelector('[role="combobox"]') === document.activeElement
      )
      assert.equal(
        await page.getByRole("dialog", { name: / actions$/ }).count(),
        0
      )
      await page.keyboard.press("Escape")
      await page.setViewportSize({ width: 800, height: 850 })
      await page.evaluate(() =>
        (window as any).fixtureAppearance.route("/playlist/fixture-playlist-0")
      )
      const tableScroll = page.getByRole("region", {
        name: "Song table",
        exact: true,
      })
      await tableScroll.waitFor()
      await page.evaluate(() =>
        (window as any).fixtureAppearance.resetInteractions()
      )
      await tableScroll.focus()
      await page.keyboard.press("ArrowRight")
      await page.waitForTimeout(150)
      assert.ok(
        await tableScroll.evaluate((e) => e.scrollLeft > 0),
        `${name}: wide song table cannot be scrolled by keyboard`
      )
      assert.equal(
        (
          await page.evaluate(() =>
            (window as any).fixtureAppearance.interactions()
          )
        ).length,
        0,
        `${name}: table scroll changed playback`
      )
      const seek = page.getByRole("slider", { name: "Seek", exact: true })
      await page.evaluate(() =>
        (window as any).fixtureAppearance.resetInteractions()
      )
      await seek.focus()
      await page.keyboard.press("ArrowRight")
      assert.equal(
        (
          await page.evaluate(() =>
            (window as any).fixtureAppearance.interactions()
          )
        ).at(-1)?.action,
        "seek",
        `${name}: waveform changes broke keyboard seeking`
      )
      await checkBackgroundFraming(page, name)
      await page.evaluate(() =>
        (window as any).fixtureAppearance.apply({ background: false })
      )
      assert.equal(await page.locator(".app-artwork-frame").count(), 0)
      const opaque = await page
        .locator(".app-playbar")
        .evaluate((e) => getComputedStyle(e).backgroundColor)
      assert.ok(
        !opaque.includes("rgba") && !opaque.includes("0.76"),
        `${name}: disabled background leaves transparent playbar`
      )
      await page.evaluate(() =>
        (window as any).fixtureAppearance.apply({ background: true })
      )
      await active.waitFor()
      await page.evaluate(() => (window as any).fixtureArtwork.retire())
      assert.equal(
        await page.locator(".app-artwork-frame").count(),
        0,
        `${name}: old account image remains visible`
      )
      assert.equal(
        await page
          .locator(".app-artwork-shell")
          .getAttribute("data-artwork-colors"),
        "off"
      )
      assert.deepEqual(errors, [], `${name}: application errors`)
      console.log(
        `${name}: appearance, full-window artwork, palette contrast, fades, seeking, detail actions and panels passed`
      )
    } finally {
      await browser.close()
    }
  }
} finally {
  if (previousPlatform === undefined) delete process.env.TAURI_ENV_PLATFORM
  else process.env.TAURI_ENV_PLATFORM = previousPlatform
  server?.stop(true)
  await disposeFixture(output)
}
