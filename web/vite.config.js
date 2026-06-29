import { defineConfig } from "vite";

// mupdf ships a large prebuilt WASM module. Excluding it from Vite's dependency
// optimizer avoids the optimizer choking on the .wasm and lets it load via its
// own import.meta.url at runtime (dev) / be emitted as an asset (build).
export default defineConfig({
  base: "./",
  optimizeDeps: { exclude: ["mupdf"] },
  build: { target: "es2022" },
});
