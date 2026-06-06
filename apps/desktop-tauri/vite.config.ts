import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Tauri convention: dev server on port 1420.
// clearScreen false keeps Rust compiler output visible alongside Vite logs.
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Tauri requires a fixed port and supports its own HMR transport.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    // Tauri injects its own HMR config; do not set `hmr` here.
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Tauri webview targets modern browsers; keep bundle small.
    target: "es2022",
    sourcemap: true,
  },
}));
