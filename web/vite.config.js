import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";

// Commit shown next to the "Source code" download (scripts/source-zip.mjs
// archives the same HEAD).
function sourceInfo() {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%h %cs"], { encoding: "utf8" });
    const [sha, date] = out.trim().split(" ");
    return { sha, date };
  } catch {
    return { sha: "", date: "" };
  }
}

// mupdf ships a large prebuilt WASM module. Excluding it from Vite's dependency
// optimizer avoids the optimizer choking on the .wasm and lets it load via its
// own import.meta.url at runtime (dev) / be emitted as an asset (build).
export default defineConfig({
  base: "./",
  optimizeDeps: { exclude: ["mupdf"] },
  build: { target: "es2022" },
  define: { __SOURCE__: JSON.stringify(sourceInfo()) },
});
