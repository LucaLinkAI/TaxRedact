# RedactTaxCLI

Redact all PII from tax-return PDFs — **truly**, not just visually.

Matched content is physically removed from the PDF content stream (via
[PyMuPDF](https://pymupdf.readthedocs.io/)) and a black box is burned in over
each spot. The result cannot be recovered by copy/paste, text selection, or by
stripping an overlay. Every run verifies that no detected PII remains in the
output text layer.

## What it detects

- **Regex on every page** (works on any tax PDF):
  - SSN / ITIN (`123-45-6789`, `123 45 6789`)
  - EIN (`12-3456789`)
  - Email addresses
  - Phone numbers (`(206) 555-1234`, `206-555-1234`, …)
  - Bank account / routing numbers (runs of 9–17 digits)
- **1040 header fields by form layout:**
  - taxpayer & spouse first/last names, home street, city, ZIP
  - names are chased through every page (they repeat in e-file headers)

Public agency numbers (IRS hotlines) and blank-EIN placeholders are
whitelisted so they aren't flagged as PII.

## Requirements

- Python 3
- PyMuPDF (`pip install pymupdf`)

The `RedactTaxCLI` launcher bootstraps a local `.venv` with PyMuPDF on first
run, so you don't have to install anything yourself.

## Usage

```bash
./RedactTaxCLI return.pdf                 # writes return_redacted.pdf
./RedactTaxCLI return.pdf -o clean.pdf    # custom output path
./RedactTaxCLI *.pdf                      # batch; writes <name>_redacted.pdf each
./RedactTaxCLI TaxFiles/                  # batch every *.pdf in a directory
./RedactTaxCLI TaxFiles/ -r              # ...recursing into subdirectories
./RedactTaxCLI return.pdf --dry-run       # report detected PII, write nothing
```

When an input is a **directory**, every `*.pdf` inside it is processed (each
written next to its source as `<name>_redacted.pdf`). Files already ending in
the output suffix are skipped, so re-running over a folder like `TaxFiles/` is
safe and idempotent. Add `-r/--recursive` to descend into subdirectories.

### Options

| Flag | Description |
| --- | --- |
| `-o, --output` | Output path (only valid with a single input PDF) |
| `-r, --recursive` | Recurse into subdirectories of any input directory |
| `--suffix` | Suffix for batch outputs (default: `_redacted`) |
| `--dry-run` | Report detected PII without writing files |
| `--no-verify` | Skip the post-redaction text-layer leak check |
| `-q, --quiet` | Suppress per-file reports |
| `--version` | Print version and exit |

## Files

- **`RedactTaxCLI`** — launcher; ensures the venv exists, then runs the CLI.
- **`redacttaxcli.py`** — the main CLI (auto-detection + 1040 layout + verify).
- **`redact_tax_return.py`** — alternative script where you pass explicit terms
  to redact via `--term` / `--terms-file` alongside regex auto-detection.
- **`redact_pii.sh`** — self-contained Bash version (bootstraps its own venv,
  embeds the Python redactor); same detection as the CLI.

## How it works

1. Detect regex-shaped PII and extract 1040 header fields by their position.
2. Add redaction annotations for every match (longest strings first, so a full
   value wins over a substring).
3. `apply_redactions()` physically removes the underlying content and draws the
   black box.
4. Re-open the output and search for every detected term to confirm nothing
   leaked back into the text layer.

## Notes

⚠️ Always review the output. Redaction is heuristic — confirm that nothing
sensitive remains, especially for non-standard or scanned (image-based) PDFs,
where text search cannot find the PII.
