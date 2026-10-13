import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // ONNX's official external-WASM entry prevents bundling a second runtime.
  // The semantic worker always supplies its verified binary and self-hosted glue.
  resolve: {
    conditions: [
      "onnxruntime-web-use-extern-wasm",
      "module",
      "browser",
      "development|production",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  // prevent vite from obscuring rust errors
  clearScreen: false,
  // tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Native codegen HTML and test artifacts must not reload the music player.
    // Tauri manages Rust changes independently of the frontend dev server.
    watch: {
      ignored: ["**/src-tauri/**", "**/.tmp/**"],
    },
  },
  // to make use of `TAURI_DEBUG` and other env variables
  // https://tauri.studio/v1/api/config#buildconfig.beforedevcommand
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // The production font-src policy allows local files, not data URLs.
    assetsInlineLimit: (filePath) =>
      /\.(?:woff2?|ttf|otf)$/i.test(filePath) ? false : undefined,
    // Tauri supports es2021
    target:
      process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari13",
    // don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? "oxc" : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
