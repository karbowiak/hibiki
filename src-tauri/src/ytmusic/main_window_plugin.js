;(function () {
  // Plugins may polyfill browser APIs and invoke native commands at startup.
  // The Google/YTM window must retain its own browser APIs and has no IPC grants.
  if (window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label !== "main")
    return
  __HIBIKI_PLUGIN_SCRIPT__
})()
