/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

/**
 * libsodium.js ships a broken ESM import: `libsodium-wrappers-sumo` imports
 * `./libsodium-sumo.mjs` (sibling file) but the actual WASM loader lives in
 * the separate `libsodium-sumo` package. This plugin rewrites that import to
 * point at the real file. See https://github.com/jedisct1/libsodium.js issues.
 */
function fixLibsodiumImport(): Plugin {
  const target = fileURLToPath(
    new URL("./node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs", import.meta.url),
  );
  return {
    name: "fix-libsodium-import",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source === "./libsodium-sumo.mjs" &&
        importer &&
        importer.includes("libsodium-wrappers-sumo")
      ) {
        return target;
      }
      return null;
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    fixLibsodiumImport(),
    tailwindcss(),
    vue(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  worker: {
    format: "es",
    plugins: () => [fixLibsodiumImport()],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Proxy API requests to the Rust backend during development.
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    // esbuild pre-bundles deps before Vite's plugin pipeline runs, so it
    // would choke on libsodium-wrappers-sumo's broken relative import
    // before `fixLibsodiumImport` can rewrite it. Excluding these keeps
    // them on the Vite plugin path where the rewrite applies. (The same
    // trick is used for vitest via `test.server.deps.inline` below.)
    exclude: ["libsodium-wrappers-sumo", "libsodium-sumo"],
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      output: {
        manualChunks: {
          // Split heavy crypto WASM libs into their own chunk so the rest of
          // the app can load fast on first paint.
          crypto: ["libsodium-wrappers-sumo"],
        },
      },
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        // Process libsodium-wrappers-sumo through the Vite plugin pipeline so
        // fixLibsodiumImport can rewrite the broken `./libsodium-sumo.mjs`
        // relative import to the real path inside the `libsodium-sumo` package.
        //
        // The rewritten leaf (`libsodium-sumo`) is intentionally NOT inlined:
        // vitest 3's vite-node intercepts `module.exports` and writes
        // `exports.default`, but libsodium-sumo's ESM module exposes `default`
        // as a getter-only property, causing "Cannot set property default".
        // Loading it natively (external) sidesteps the interception while the
        // resolveId rewrite above still points the import at the right file.
        inline: ["libsodium-wrappers-sumo"],
        external: ["libsodium-sumo", /^libsodium-sumo\//],
      },
    },
  },
});
