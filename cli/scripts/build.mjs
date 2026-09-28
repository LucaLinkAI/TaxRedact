// Bundle the CLI into a self-contained, dependency-free package and publish it
// to the web app's downloads:
//   dist/redacttax/            redacttax.mjs + mupdf-wasm.wasm + docs + package.json
//   ../web/public/downloads/   redacttax-<ver>.tgz  (npm install -g <url>)
//                              redacttax-<ver>.zip  (unzip, node redacttax.mjs)
// Run with: npm run build   (then build/deploy web/ as usual)
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
const out = `${root}dist/redacttax/`;
const downloads = `${root}../web/public/downloads/`;

rmSync(`${root}dist`, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [`${root}src/cli.js`],
  outfile: `${out}redacttax.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "linked",
  // Ink only uses react-devtools-core when DEV=true; bundling pulls its import
  // to the top level, so point it at an empty stub instead.
  plugins: [{
    name: "stub-devtools",
    setup(b) {
      b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "stub", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "export default { initialize() {}, connectToDevTools() {} };",
      }));
    },
  }],
  define: { "process.env.NODE_ENV": '"production"' },
  // Some bundled deps are CommonJS and call require().
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});

// mupdf loads its WASM from next to the module (import.meta.url).
copyFileSync(`${root}node_modules/mupdf/dist/mupdf-wasm.wasm`, `${out}mupdf-wasm.wasm`);
copyFileSync(`${root}HELP.md`, `${out}HELP.md`);
copyFileSync(`${root}README.md`, `${out}README.md`);
writeFileSync(`${out}package.json`, JSON.stringify({
  name: "redacttax",
  version: pkg.version,
  description: pkg.description,
  type: "module",
  bin: { redacttax: "redacttax.mjs" },
  engines: pkg.engines,
  license: "UNLICENSED",
}, null, 2) + "\n");

// Replace older builds so the site only offers the current version.
rmSync(downloads, { recursive: true, force: true });
mkdirSync(downloads, { recursive: true });
const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", downloads], { cwd: out })
  .toString().trim().split("\n").pop();
execFileSync("zip", ["-qr", `${downloads}redacttax-${pkg.version}.zip`, "redacttax"], { cwd: `${root}dist` });
writeFileSync(`${downloads}latest.json`, JSON.stringify({
  version: pkg.version, tgz, zip: `redacttax-${pkg.version}.zip`,
}) + "\n");
console.log(`built ${out}\npublished ${downloads}${tgz} and redacttax-${pkg.version}.zip`);
