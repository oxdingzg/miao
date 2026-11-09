import appPlugin from "@miao/app/vite"
import { defineConfig } from "vite"

// `tauri dev` serves this bundle on 1420 and renders it in the system WebView;
// the same config produces the `dist/` that the bundle embeds.
export default defineConfig({
  plugins: [appPlugin],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "esnext" },
})
