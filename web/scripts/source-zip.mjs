// Package the repo's source for the "Source code" download on the page:
//   public/downloads/taxredact-source.zip   (git archive of HEAD)
// Only committed files go in, so .gitignored tax PDFs, node_modules, builds
// and anything uncommitted can never leak into the public download.
// Runs as part of `npm run build` (prebuild), after the cli build.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const downloads = new URL("../public/downloads/", import.meta.url).pathname;

mkdirSync(downloads, { recursive: true });
const sha = git("rev-parse", "--short", "HEAD");
git("archive", "--format=zip", "--prefix=TaxRedact/",
    "-o", `${downloads}taxredact-source.zip`, "HEAD");
if (git("status", "--porcelain", "--untracked-files=no")) {
  console.warn(`source-zip: working tree has uncommitted changes; the download ` +
               `contains commit ${sha} only.`);
}
console.log(`source-zip: taxredact-source.zip (commit ${sha})`);
