import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Production build optimizations
  build: {
    // Target compatible with Tauri WebViews across platforms:
    // - macOS: WebKit (Safari 13+)
    // - Windows: WebView2 (Chromium-based)
    // - Linux: WebKitGTK
    target: ["es2021", "chrome105", "safari14"],
    // Optimize chunk splitting
    rolldownOptions: {
      output: {
        // Manual chunk splitting for better caching
        codeSplitting: {
          groups: [
            // TipTap and related editor libraries
            {
              name: "tiptap",
              test: /node_modules[\\/]@tiptap[\\/](react|starter-kit|markdown|extension-(link|image|placeholder|task-list|task-item|table|table-row|table-cell|table-header|code-block-lowlight))[\\/]/,
            },
            // Syntax highlighting
            {
              name: "highlight",
              test: /node_modules[\\/](lowlight|highlight\.js)[\\/]/,
            },
            // React core
            {
              name: "react-vendor",
              test: /node_modules[\\/](react|react-dom)[\\/]/,
            },
            // Tauri APIs
            {
              name: "tauri",
              test: /node_modules[\\/]@tauri-apps[\\/](api|plugin-dialog|plugin-opener)[\\/]/,
            },
          ],
        },
      },
    },
    // Enable source maps for debugging (optional, can disable for smaller builds)
    sourcemap: false,
    // Increase chunk size warning limit (TipTap is large)
    chunkSizeWarningLimit: 1000,
  },

  // Optimize dependencies
  optimizeDeps: {
    // Pre-bundle these dependencies for faster dev startup
    include: [
      "react",
      "react-dom",
      "@tiptap/react",
      "@tiptap/starter-kit",
      "@tiptap/markdown",
      "lowlight",
      // Imported only by the E2E fake backend; listing it avoids a page reload
      // when Vite discovers it mid-test.
      "@tauri-apps/api/mocks",
    ],
  },
}));
