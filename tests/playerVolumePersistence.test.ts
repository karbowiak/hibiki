import { expect, test } from "bun:test"
import { resolve } from "node:path"

test("a saved muted player restores its previous audible volume after hydration", async () => {
  // Existing store tests share imported singletons. This fresh process installs
  // browser storage before the application's real persistence middleware starts.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { JSDOM } from "jsdom";
    const dom = new JSDOM("", { url: "https://hibiki.example.test" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;
    const { usePlayerStore: store } = await import("./src/stores/playerStore");
    const { engine } = await import("./src/audio/RustAudioEngine");
    engine.setVolume = () => {};
    store.getState().setVolume(19);
    store.getState().toggleMute();
    let saved = JSON.parse(localStorage.getItem("plex-player-prefs"));
    if (saved.state.volume !== 0 || saved.state.lastAudibleVolume !== 19) throw Error("Muted level was not persisted");
    store.persist.setOptions({ storage: {
      getItem: () => saved,
      setItem: () => {},
      removeItem: () => {},
    }});
    store.setState({ volume: 80, lastAudibleVolume: 80 });
    await store.persist.rehydrate();
    if (store.getState().volume !== 0) throw Error("Muted volume was not restored");
    store.getState().toggleMute();
    if (store.getState().volume !== 19) throw Error("Unmute lost the saved level");
    saved = { state: { volume: 33 }, version: 0 };
    await store.persist.rehydrate();
    store.getState().toggleMute();
    store.getState().toggleMute();
    if (store.getState().volume !== 33) throw Error("Legacy preferences lost their audible level");
    dom.window.close();
    console.log("volume persistence verified");
  `,
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
  expect(stdout.trim()).toBe("volume persistence verified")
})
