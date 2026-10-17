import { expect, test } from "bun:test"
import { resolve } from "node:path"

async function isolated(body: string) {
  const child = Bun.spawn([process.execPath, "-e", `
    import { JSDOM } from "jsdom";
    const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.example.test" });
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    const values = new Map(); let unreadable = false, unwritable = false;
    const backend = { getItem(key) { if (unreadable) throw Error("read failed"); return values.get(key) ?? null; },
      setItem(key, value) { if (unwritable) throw Error("write failed"); values.set(key, value); }, removeItem(key) { values.delete(key); } };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { if (unreadable) throw Error("storage unavailable"); return backend; } });
    const check = (condition, message) => { if (!condition) throw Error(message); };
    const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    ${body}
    dom.window.close(); console.log("verified");
  `], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
  expect(stdout.trim()).toBe("verified")
}

test("scalar startup survives unavailable storage and recovery preserves later local intent", async () => {
  await isolated(`
    values.set("plex-queue-pinned", "1"); values.set("plex-debug-enabled", "1"); unreadable = true;
    const { useUIStore: ui } = await import("./src/stores/uiStore");
    const { useDebugStore: debug } = await import("./src/stores/debugStore");
    const { useNotificationStore: notices } = await import("./src/stores/notificationStore");
    const { useAccentStore: accent } = await import("./src/stores/accentStore");
    const { localPreferencePersistence: persistence } = await import("./src/stores/localPreferenceStorage");
    check(!ui.getState().isQueuePinned && !debug.getState().debugEnabled, "wrong safe defaults");
    check(notices.getState().notificationsEnabled && accent.getState().accent === "#d946ef", "wrong defaults");
    ui.getState().setQueuePinned(false); notices.getState().setNotificationsEnabled(false);
    await settle();
    check(values.get("plex-queue-pinned") === "1", "unreadable data overwritten");
    check(persistence.snapshot().some(issue => issue.hasPendingChanges), "pending intent hidden");
    unreadable = false; await persistence.retry(); await persistence.flushForShutdown();
    check(!ui.getState().isQueuePinned && debug.getState().debugEnabled, "recovery lost local intent or saved state");
    check(values.get("plex-queue-pinned") === "0" && values.get("plex-notifications-enabled") === "0", "legacy format changed");
  `)
})

test("a saved pinned queue opens docked with its saved tab after startup", async () => {
  await isolated(`
    values.set("plex-queue-pinned", "1"); values.set("plex-queue-tab", "lyrics");
    const { useUIStore: ui } = await import("./src/stores/uiStore");
    const { localPreferencePersistence: persistence } = await import("./src/stores/localPreferenceStorage");
    await settle();
    check(ui.getState().isQueuePinned && ui.getState().isQueueOpen, "pinned panel was hidden at startup");
    check(ui.getState().queueActiveTab === "lyrics", "saved tab was lost");
    ui.getState().setQueueOpen(false);
    check(ui.getState().isQueuePinned && !ui.getState().isQueueOpen, "close discarded docking preference");
    ui.getState().setQueueOpen(true); ui.getState().setQueueActiveTab("queue");
    await persistence.flushForShutdown();
    check(ui.getState().isQueuePinned && ui.getState().isQueueOpen, "reopened panel lost docking");
    check(values.get("plex-queue-tab") === "queue", "tab choice was not saved");
  `)
})

test("malformed scalar values stay on disk and failed writes remain pending until retry", async () => {
  await isolated(`
    values.set("plex-accent-color", "garbage"); values.set("plex-debug-enabled", "future");
    const { useAccentStore: accent } = await import("./src/stores/accentStore");
    const { useDebugStore: debug } = await import("./src/stores/debugStore");
    const { useNotificationStore: notices } = await import("./src/stores/notificationStore");
    const { localPreferencePersistence: persistence } = await import("./src/stores/localPreferenceStorage");
    await settle(); accent.getState().setAccent("#123456"); debug.getState().setDebugEnabled(true);
    await persistence.flush();
    check(values.get("plex-accent-color") === "garbage" && values.get("plex-debug-enabled") === "future", "malformed data erased");
    accent.getState().setAccent("invalid"); check(accent.getState().accent === "#123456", "invalid setter accepted");
    unwritable = true; notices.getState().setNotificationsEnabled(false); await settle(); await persistence.flush();
    check(!notices.getState().notificationsEnabled, "failed write aborted UI");
    check(persistence.snapshot().some(issue => issue.operation === "write" && issue.hasPendingChanges), "failed write reported saved");
    let blocked = false; try { await persistence.flushForShutdown(); } catch { blocked = true; }
    check(blocked, "shutdown ignored unsaved edits");
    values.set("plex-accent-color", "#abcdef"); values.set("plex-debug-enabled", "0"); unwritable = false;
    await persistence.retry(); await persistence.flushForShutdown();
    check(values.get("plex-accent-color") === "#123456" && values.get("plex-debug-enabled") === "1", "retry lost staged edits");
    check(values.get("plex-notifications-enabled") === "0", "write retry failed");
    check(document.documentElement.style.getPropertyValue("--accent-rgb") === "18 52 86", "accent CSS corrupted");
  `)
})

test("column preferences validate arrays, retain malformed bytes, and recover rapid toggles across remounts", async () => {
  await isolated(`
    const React = await import("react"); const { createRoot } = await import("react-dom/client"); const { flushSync } = await import("react-dom");
    const { usePlaylistColumns } = await import("./src/hooks/useColumnPicker");
    const { localPreferencePersistence: persistence } = await import("./src/stores/localPreferenceStorage");
    let result; function Fixture({ storageKey }) { result = usePlaylistColumns(storageKey, ["album"]); return null; }
    const root = createRoot(document.getElementById("root"));
    for (const [key, raw] of [["object", "{}"], ["string", '"artist"'], ["unknown", '["future"]']]) {
      values.set(key, raw); flushSync(() => root.render(React.createElement(Fixture, { storageKey: key })));
      check(result.visible.has("album"), "malformed value hydrated");
      flushSync(() => result.toggle("year")); await settle(); await persistence.flush();
      check(values.get(key) === raw, "malformed columns overwritten");
    }
    values.set("valid", '["artist"]');
    flushSync(() => root.render(React.createElement(Fixture, { storageKey: "valid" })));
    check(result.visible.has("artist") && !result.visible.has("album"), "key change reused old columns");
    await settle(); unwritable = true;
    flushSync(() => { result.toggle("year"); result.toggle("rating"); }); await settle(); await persistence.flush();
    check(result.visible.has("year") && result.visible.has("rating"), "rapid toggles lost state");
    check(values.get("valid") === '["artist"]', "failed write changed disk");
    flushSync(() => root.render(null)); flushSync(() => root.render(React.createElement(Fixture, { storageKey: "valid" })));
    check(result.visible.has("year") && result.visible.has("rating"), "remount lost pending edits");
    unwritable = false; await persistence.retry(); await persistence.flush();
    check(JSON.parse(values.get("valid")).join(",") === "artist,year,rating", "column retry failed");
    flushSync(() => root.unmount());
  `)
})

test("unreadable column preferences keep edits pending and replay them after storage recovery", async () => {
  await isolated(`
    const React = await import("react"); const { createRoot } = await import("react-dom/client"); const { flushSync } = await import("react-dom");
    const { usePlaylistColumns } = await import("./src/hooks/useColumnPicker");
    const { localPreferencePersistence: persistence } = await import("./src/stores/localPreferenceStorage");
    values.set("unreadable-columns", '["artist"]'); unreadable = true;
    let result; function Fixture() { result = usePlaylistColumns("unreadable-columns", ["album"]); return null; }
    const root = createRoot(document.getElementById("root"));
    flushSync(() => root.render(React.createElement(Fixture)));
    flushSync(() => { result.toggle("year"); result.toggle("year"); }); await settle();
    check(values.get("unreadable-columns") === '["artist"]', "failed read erased saved columns");
    check(persistence.snapshot().some(issue => issue.hasPendingChanges), "default-valued toggle intent lost");
    unreadable = false; await persistence.retry(); await persistence.flushForShutdown();
    check(values.get("unreadable-columns") === '["album"]', "recovery ignored user's final column selection");
    check(result.visible.has("album") && !result.visible.has("artist"), "retry replaced visible intent");
    flushSync(() => root.unmount());
  `)
})

test("download column defaults on for saved layouts and its independent toggle survives remounts", async () => {
  await isolated(`
    const React = await import("react"); const { createRoot } = await import("react-dom/client"); const { flushSync } = await import("react-dom");
    const { usePlaylistColumns } = await import("./src/hooks/useColumnPicker");
    const { localPreferencePersistence: persistence } = await import("./src/stores/localPreferenceStorage");
    values.set("existing-layout", '["album","rating"]');
    values.set("previously-hidden-downloads", '["artist"]');
    values.set("previously-hidden-downloads-downloads-visible", "0");
    let result; function Fixture({ storageKey }) { result = usePlaylistColumns(storageKey); return null; }
    const root = createRoot(document.getElementById("root"));
    flushSync(() => root.render(React.createElement(Fixture, { storageKey: "existing-layout" })));
    check(result.visible.has("downloads") && result.visible.has("rating") && !result.visible.has("artist"), "new column reset existing layout");
    await settle(); flushSync(() => result.toggle("downloads")); await settle(); await persistence.flush();
    check(!result.visible.has("downloads") && result.visible.has("rating"), "download toggle changed other columns");
    check(values.get("existing-layout") === '["album","rating"]', "existing column bytes were rewritten");
    check(values.get("existing-layout-downloads-visible") === "0", "off choice was not saved");
    flushSync(() => root.render(null)); flushSync(() => root.render(React.createElement(Fixture, { storageKey: "existing-layout" })));
    check(!result.visible.has("downloads"), "remount restored hidden column");
    flushSync(() => { result.toggle("downloads"); result.toggle("downloads"); result.toggle("downloads"); }); await settle(); await persistence.flush();
    check(result.visible.has("downloads") && values.get("existing-layout-downloads-visible") === "1", "rapid toggles lost final choice");
    flushSync(() => root.render(React.createElement(Fixture, { storageKey: "previously-hidden-downloads" })));
    check(!result.visible.has("downloads") && result.visible.has("artist"), "saved off choice was not loaded");
    flushSync(() => root.render(React.createElement(Fixture, { storageKey: "fresh-layout" })));
    check(result.visible.has("downloads"), "fresh layout did not default on");
    flushSync(() => root.unmount());
  `)
})
