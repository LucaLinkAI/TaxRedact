# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A tax-return PDF PII redactor that performs **true** redaction: matched content
is physically removed from the PDF content stream (via MuPDF) and a black box is
burned in, so it can't be recovered by copy/paste, text selection, or stripping
an overlay. Every run re-opens the output and searches for each detected term to
confirm nothing leaked back into the text layer.

There are two parallel implementations of the *same engine and detection logic*:
- **CLI** (Python + PyMuPDF) at the repo root.
- **Web app** (`web/`, JavaScript + mupdf.js/WASM) — runs entirely in the
  browser, PDF never leaves the device; deployed as a static site to Cloudflare Pages.

A third front end, **`cli/`** (`redacttax`, Node + React/Ink), has no engine
of its own: it imports `web/src/redact.js`.

When changing detection behavior, **keep both implementations in sync** — the
patterns, whitelist, `HEADER_FIELDS`, K-1 labels, and the learned-name/address
helpers are deliberately mirrored across `redacttaxcli.py` and
`web/src/redact.js`. Same sample batch → same region counts in both is the
quick parity check.

## Commands

### CLI
```bash
./RedactTaxCLI return.pdf                 # writes return_redacted.pdf
./RedactTaxCLI return.pdf --dry-run       # report detected PII, write nothing
./RedactTaxCLI TaxFiles/ -r               # batch every *.pdf, recursing
```
`RedactTaxCLI` is a Bash launcher that bootstraps a local `.venv` with PyMuPDF on
first run, then execs `redacttaxcli.py`. There is no formal test suite — verify
changes with `--dry-run` against a sample PDF.

### Terminal (React/Ink, same engine as web)
```bash
cd cli && npm install
node src/cli.js TaxFiles/ -r -o Clean/    # files and/or folders; --help prints HELP.md
npm run build                             # bundle -> dist/ + .tgz/.zip into web/public/downloads/
```
`web`'s `prebuild` runs the cli build, so the site always serves the current CLI
download. esbuild stubs `react-devtools-core`: Ink imports it statically, and
the bundle breaks without the stub. Test the `.tgz` by installing it outside
the repo, never only from inside it.

The site also serves `downloads/taxredact-source.zip` (`web/scripts/source-zip.mjs`,
a `git archive` of HEAD), so **every committed file is public**. Never put real
client names, addresses or numbers in code, comments, docs or commit-tracked
fixtures. Use made-up examples ("Jane Doe", "Springfield, IL 62704").

### Web
```bash
cd web
npm install
npm run dev                               # http://localhost:5173
npm run test:node test/pii.pdf            # run the engine in Node against a PDF
npm run build                             # static bundle -> web/dist/
```
`test:node` (`test/node_check.mjs`) is the closest thing to a test: it redacts
given PDFs, asserts the verify pass finds no leaks, and cross-checks that no
detected value survives as a substring. Pass real PDFs as args (not committed).

## Architecture

### Detection (shared logic, two layers)
1. **Regex on every page** — `PATTERNS`: SSN/ITIN, EIN, email, phone,
   account/routing (9–17 digit runs). `WHITELIST` excludes IRS hotlines and the
   blank-EIN placeholder so they aren't flagged.
2. **1040 header fields by layout** — `HEADER_FIELDS` is a table of
   `(label, x-min, x-max, occurrence, digits-only, kind)`. The code finds the
   1040 page (by the literal "Your first name and middle initial"), locates each
   label rect, then reads the words sitting just below it within the x-range to
   recover names/street/city/ZIP.
3. **K-1 recipient block** (`K1_NAME_LABELS`: partner/shareholder/beneficiary),
   read from the row under each label (2025+ separate Street/City/ZIP cells, or
   the older combined box), and **letter address blocks** (`Name / street /
   City, ST ZIP`, name kept only if it looks like a person, not an entity).
4. Everything from 1–3 lands in a `learned` map of normalized token phrases,
   matched word-by-word on every page: full phrases, plus each name word alone
   (whole, capitalized words only). In a batch (all three front ends) pass 1
   collects `learned` from every file and pass 2 redacts each file with the
   union (`shared`), so cover letters without labels are covered.

### Redaction flow (`redact_pdf` / `redactPdf`)
Detect → add redaction annotations for every match, **longest strings first** so
a full value wins over a substring (boxes trimmed 20% top/bottom, since MuPDF
removes any glyph a rect touches and tall boxes graze adjacent lines) → `apply_redactions()` physically removes
content and draws the black box → re-open and search to report `leaks`. Header
fields also get geometric boxes (`geo_boxes`) on the 1040 page itself, since the
header values may not be found by text search there.

### Files
- `redacttaxcli.py` — main CLI: auto-detection + 1040 layout + verify + batch/dir handling.
- `redact_tax_return.py` — alternative script taking explicit `--term`/`--terms-file` values alongside regex auto-detection (no 1040 layout logic). Standalone variant, not used by the launcher.
- `redact_pii.sh` — self-contained Bash version that embeds its own Python redactor.
- `web/src/redact.js` — port of the CLI engine; environment-agnostic (the `mupdf` module is passed in by the caller). Reconstructs PyMuPDF's `get_text("words")` by walking mupdf.js structured text.
- `web/src/main.js` — browser UI: multi-file/folder batch, per-file links + zip (fflate); lazy-loads the ~10 MB WASM module on first redaction.
- `cli/src/` — `cli.js` (entry), `files.js` (args + recursive expansion), `App.js` (Ink UI, two-pass batch). `cli/HELP.md` is what `--help` prints.
- mupdf.js is pinned to `~1.28` in both `web/` and `cli/`: from 1.28 `page.search()` takes an options string and needs `"ignore-case"` to match PyMuPDF.

## Caveats baked into the design
- Redaction is heuristic; output should always be reviewed.
- Scanned/image-based PDFs have no text layer, so nothing is detected — the
  apps surface a warning rather than failing.
- A non-empty `leaks` list (CLI) sets a non-zero exit code.
