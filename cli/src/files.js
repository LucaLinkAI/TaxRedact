// Argument parsing and input expansion for the redacttax CLI (no Ink here, so
// it stays easy to reason about and reuse).
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

export function parseArgs(argv) {
  const opts = {
    inputs: [], recursive: false, outDir: null, suffix: "_redacted",
    dryRun: false, verify: true, share: true, quiet: false,
    help: false, version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "-h" || a === "--help" || a === "help") opts.help = true;
    else if (a === "-v" || a === "--version") opts.version = true;
    else if (a === "-r" || a === "--recursive") opts.recursive = true;
    else if (a === "-o" || a === "--out-dir") opts.outDir = value();
    else if (a === "--suffix") opts.suffix = value();
    else if (a === "-n" || a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-verify") opts.verify = false;
    else if (a === "--no-share") opts.share = false;
    else if (a === "-q" || a === "--quiet") opts.quiet = true;
    else if (a.startsWith("-") && a !== "-") throw new Error(`unknown option: ${a}`);
    else opts.inputs.push(a);
  }
  return opts;
}

const isPdf = (p) => extname(p).toLowerCase() === ".pdf";

function walk(dir, recursive, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { if (recursive) walk(p, recursive, out); }
    else if (entry.isFile() && isPdf(p)) out.push(p);
  }
}

/**
 * Expand files/directories into jobs: [{ src, dst }]. Directory contents skip
 * files already ending in the output suffix, so re-running is idempotent.
 * With --out-dir, files found under a directory keep their relative path.
 * Returns { jobs, problems }.
 */
export function collectJobs(opts) {
  const jobs = [];
  const problems = [];
  const seen = new Set();
  const stripped = (p) => basename(p, extname(p));
  const add = (src, root) => {
    const abs = resolve(src);
    if (seen.has(abs)) return;
    seen.add(abs);
    const name = `${stripped(src)}${opts.suffix}.pdf`;
    const dst = opts.outDir
      ? join(opts.outDir, root ? dirname(relative(root, src)) : "", name)
      : join(dirname(src), name);
    jobs.push({ src, dst });
  };
  for (const input of opts.inputs) {
    if (!existsSync(input)) { problems.push(`not found: ${input}`); continue; }
    if (statSync(input).isDirectory()) {
      const found = [];
      walk(input, opts.recursive, found);
      const pdfs = found.filter((p) => !stripped(p).endsWith(opts.suffix));
      if (!pdfs.length) {
        problems.push(`no PDFs in ${input}${opts.recursive ? "" : " (use -r to recurse)"}`);
      }
      for (const p of pdfs) add(p, input);
    } else if (!isPdf(input)) {
      problems.push(`not a .pdf file: ${input}`);
    } else {
      add(input, null);
    }
  }
  return { jobs, problems };
}
