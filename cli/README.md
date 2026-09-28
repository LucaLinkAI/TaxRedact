# redacttax — terminal redactor (React / Ink)

A terminal front end for the tax-PDF PII redactor, built with
[Ink](https://github.com/vadimdemedes/ink) (React for the command line). It
runs the **same engine as the web app** ([`../web/src/redact.js`](../web/src/redact.js),
mupdf.js/WebAssembly), so detection is identical in the browser and the terminal.
Everything happens locally, and no file is uploaded anywhere.

It processes one file, many files, or whole folders (optionally recursive) in a
single batch, with a live per-file progress list.

## Install

Requires Node.js 20 or newer.

**Prebuilt (for users):** the web app offers a download under "Command-line
version", and it installs with one command:

```bash
npm install -g https://tax-pdf-redactor.pages.dev/downloads/redacttax-1.1.0.tgz
```

The portable `.zip` from the same page needs no npm at all: unzip it and run
`node redacttax/redacttax.mjs ...`.

### Mac, step by step

1. **Install Node.js** (one time): download the macOS LTS installer (.pkg)
   from <https://nodejs.org/> and double-click it. Homebrew users can run
   `brew install node` instead.
2. **Open Terminal**: `Cmd` + `Space`, type *Terminal*, then `Return`.
   Run `node -v` and check that it prints v20 or higher.
3. **Install redacttax**:
   ```bash
   npm install -g https://tax-pdf-redactor.pages.dev/downloads/redacttax-1.1.0.tgz
   ```
   If you get `EACCES: permission denied` (common with the nodejs.org
   installer), put `sudo ` in front of that command and enter your Mac login
   password. Nothing appears on screen while you type it.
4. **Check it worked**: `redacttax --help`
5. **Redact a folder**: type `redacttax -r ` (with a trailing space), drag the
   folder from Finder into the Terminal window to fill in its path, then press
   `Return`. Every PDF inside, including subfolders, gets a `_redacted.pdf` copy
   next to it. Add `--dry-run` to only list what would be removed.
6. **Update** by re-running step 3. **Uninstall** with
   `npm uninstall -g redacttax` (use `sudo` if you installed with it).

**From source (for development):**

```bash
cd cli
npm install
npm link            # optional: puts `redacttax` on your PATH
```

Without `npm link`, run it as `node cli/src/cli.js ...` (or `npm start -- ...`
from inside `cli/`).

## Usage

```bash
redacttax return.pdf                  # -> return_redacted.pdf next to it
redacttax k1.pdf letter.pdf 1040.pdf  # several files as one batch
redacttax TaxFiles/                   # every PDF directly in the folder
redacttax TaxFiles/ -r                # ...and in all subfolders
redacttax TaxFiles/ -r -o Clean/      # outputs under Clean/, same structure
redacttax TaxFiles/ -r --dry-run      # list what would be redacted, write nothing
redacttax --help                      # full help (prints HELP.md)
```

The full option list, including what gets redacted and the exit codes, is in
[HELP.md](HELP.md). `redacttax --help` prints the same file.

### Key options

| Flag | Meaning |
| --- | --- |
| `-r, --recursive` | Descend into subfolders of folder inputs |
| `-o, --out-dir DIR` | Write outputs to `DIR`, keeping each folder's relative structure |
| `--suffix TEXT` | Output suffix (default `_redacted`); such files are skipped when scanning folders, so re-runs are safe |
| `-n, --dry-run` | Show detected values per file, write nothing |
| `--no-share` | Don't reuse names/addresses across files in the batch |
| `--no-verify` | Skip the post-redaction leak check |
| `-q, --quiet` | Only show problem files plus the summary |

## How a batch runs

1. **Scan**: every PDF is read, and names and addresses are learned from each one
   (1040 header, Schedule K-1 recipient block, letter-style address blocks).
2. **Redact**: each file is redacted with its own findings *plus* everything
   learned from the other files. A cover letter or a supplemental statement
   with no labeled fields is still cleaned when its K-1 or 1040 is in the same
   batch.
3. **Verify**: the output is re-opened and searched to confirm no detected
   value is still in the text layer. Any file with a leftover value is flagged
   and the exit code is 1.

## Packaging and publishing

```bash
npm run build     # scripts/build.mjs
```

This bundles everything with esbuild into `dist/redacttax/`: one
`redacttax.mjs` with no runtime dependencies, plus `mupdf-wasm.wasm`, the docs
and a minimal `package.json`. It then writes `redacttax-<version>.tgz`
(`npm pack`) and `.zip` to `../web/public/downloads/`. `web`'s `prebuild`
runs this automatically, so `npm run build` in `web/` and a normal deploy
always ship the current CLI. To release a new version, bump `version` in
`cli/package.json`; the page reads it at build time.

## Files

- `src/cli.js`: entry point, argument handling, `--help` / `--version`
- `src/files.js`: option parsing and file/folder expansion (recursive walk)
- `src/App.js`: the Ink UI and the two-pass batch runner
- `scripts/build.mjs`: bundle + pack + publish into the web app's downloads
- `HELP.md`: the help file shown by `--help`

The CLI has no detection logic of its own. Change detection in
`web/src/redact.js` and mirror it in `../redacttaxcli.py`.

## Caveat

Redaction is heuristic. Open each output and review it before sharing.
Scanned (image-only) PDFs have no text layer, so they are flagged "nothing
detected" instead of being redacted.
