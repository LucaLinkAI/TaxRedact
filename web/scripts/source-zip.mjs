// Package the repo's source for the "Source code" download on the page:
//   public/downloads/taxredact-source.zip   (git archive of HEAD)
// Only committed files go in, so .gitignored tax PDFs, node_modules, builds
// and anything uncommitted can never leak into the public download.
// Runs as part of `npm run build` (prebuild), after the cli build.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const downloads = new URL("../public/downloads/", import.meta.url).pathname;
// Run from the repo root: from web/, `git archive HEAD` would only take web/.
let top;
try {
  top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: new URL(".", import.meta.url).pathname, encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  // e.g. building from the downloaded source zip, which has no .git
  console.warn("source-zip: not a git checkout; skipping taxredact-source.zip");
  process.exit(0);
}
const git = (...args) => execFileSync("git", args, { cwd: top, encoding: "utf8" }).trim();

mkdirSync(downloads, { recursive: true });
const sha = git("rev-parse", "--short", "HEAD");
git("archive", "--format=zip", "--prefix=TaxRedact/",
    "-o", `${downloads}taxredact-source.zip`, "HEAD");
if (git("status", "--porcelain", "--untracked-files=no")) {
  console.warn(`source-zip: working tree has uncommitted changes; the download ` +
               `contains commit ${sha} only.`);
}
console.log(`source-zip: taxredact-source.zip (commit ${sha})`);
