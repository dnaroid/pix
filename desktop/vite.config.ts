import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { sandboxEngines } from "./sandbox-engines.vite.ts";

export default defineConfig({
  plugins: [tailwindcss(), svelte(), sandboxEngines()],
  clearScreen: false,
  server: {
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
