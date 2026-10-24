import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Workspace TypeScript packages are bundled; the native addon stays external (loaded from node_modules).
const bundled = ["@murmur/text", "@murmur/speech", "@murmur/account-api"];

// Test modes (--smoke, --capture, --compare, --latency) run in a packaged app only when it is
// built with MURMUR_TEST_MODES=1; in development they are always available.
export default defineConfig(({ command }) => ({
  main: {
    define: {
      __MURMUR_TEST_MODES__: JSON.stringify(
        command === "serve" || process.env.MURMUR_TEST_MODES === "1",
      ),
    },
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          capsule: resolve(__dirname, "src/preload/capsule.ts"),
          audio: resolve(__dirname, "src/preload/audio.ts"),
          hub: resolve(__dirname, "src/preload/hub.ts"),
          scratchpad: resolve(__dirname, "src/preload/scratchpad.ts"),
          transform: resolve(__dirname, "src/preload/transform.ts"),
        },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          capsule: resolve(__dirname, "src/renderer/capsule/index.html"),
          audio: resolve(__dirname, "src/renderer/audio/index.html"),
          hub: resolve(__dirname, "src/renderer/hub/index.html"),
          scratchpad: resolve(__dirname, "src/renderer/scratchpad/index.html"),
          transform: resolve(__dirname, "src/renderer/transform/index.html"),
        },
      },
    },
  },
}));
