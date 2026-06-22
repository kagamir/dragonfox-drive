import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";

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
  plugins: [fixLibsodiumImport(), vue()],
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
});
