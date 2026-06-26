#!/usr/bin/env bash
#
# redact_pii.sh — Redact all PII from a tax-return PDF (true redaction).
#
# Usage:
#   ./redact_pii.sh INPUT.pdf [-o OUTPUT.pdf] [--dry-run]
#
# What it removes (physically, from the content stream — not just covered):
#   * Regex auto-detected on every page (works on any tax PDF):
#       - SSN / ITIN, EIN, phone numbers, email addresses,
#         bank account / routing numbers (9-17 digit runs)
#   * 1040 header fields extracted by form layout:
#       - taxpayer & spouse first/last name, home street address,
#         city, and ZIP code
#     The extracted names are then redacted on every page (they repeat in
#     the page headers of e-file copies).
#
# Self-contained: bootstraps a local Python venv with PyMuPDF on first run.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/.venv"

# ---- args ----------------------------------------------------------------
INPUT=""; OUTPUT=""; DRYRUN="0"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output) OUTPUT="$2"; shift 2 ;;
    --dry-run)   DRYRUN="1"; shift ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    -*)          echo "Unknown option: $1" >&2; exit 2 ;;
    *)           INPUT="$1"; shift ;;
  esac
done

if [[ -z "$INPUT" ]]; then
  echo "Usage: $0 INPUT.pdf [-o OUTPUT.pdf] [--dry-run]" >&2
  exit 2
fi
if [[ ! -f "$INPUT" ]]; then
  echo "Input not found: $INPUT" >&2
  exit 1
fi
if [[ -z "$OUTPUT" ]]; then
  OUTPUT="${INPUT%.pdf}_redacted.pdf"
fi

# ---- ensure venv + PyMuPDF ----------------------------------------------
PYBIN="$VENV/bin/python"
if [[ ! -x "$PYBIN" ]] || ! "$PYBIN" -c 'import fitz' 2>/dev/null; then
  echo ">> Setting up Python environment (one-time)..." >&2
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet pymupdf
fi

# ---- run the redactor ----------------------------------------------------
"$PYBIN" - "$INPUT" "$OUTPUT" "$DRYRUN" <<'PYEOF'
import re, sys
import fitz

inp, outp, dryrun = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
doc = fitz.open(inp)

# --- 1. regex-shaped PII (specific enough to search every page) ----------
PATTERNS = {
    "SSN/ITIN": re.compile(r"\b\d{3}[-\s]\d{2}[-\s]\d{4}\b"),
    "EIN":      re.compile(r"\b\d{2}-\d{7}\b"),
    "Email":    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    "Phone":    re.compile(r"(?<!\d)(?:\(\d{3}\)\s*|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?!\d)"),
    "Account#": re.compile(r"\b\d{9,17}\b"),
}
report = {}        # value -> label, for the printed report
search_terms = {}  # value -> label, redacted on EVERY page via text search
for page in doc:
    text = page.get_text()
    for label, rx in PATTERNS.items():
        for m in rx.findall(text):
            report[m.strip()] = label
            search_terms[m.strip()] = label

# --- 2. 1040 header fields, extracted by form layout ---------------------
# Names are also chased through later pages (they repeat in e-file headers).
# Street / city / ZIP are short and would over-match as substrings, so they
# are redacted ONLY by their geometric box on page 0.
# Field: (label, x-min, x-max, occurrence index, digits-only, kind)
FIELDS = [
    ("Your first name",  38, 235, 0, False, "first name"),
    ("Last name",       235, 465, 0, False, "last name"),
    ("If joint return",  38, 235, 0, False, "spouse first name"),
    ("Last name",       235, 465, 1, False, "spouse last name"),
    ("Home address",     38, 460, 0, False, "street"),
    ("City, town",       38, 350, 0, False, "city"),
    ("ZIP code",        400, 488, 0, True,  "zip"),
]
geo_boxes = []   # rects redacted directly on page 0
page0 = doc[0]
words = page0.get_text("words")
for label, xmin, xmax, pick, digits_only, kind in FIELDS:
    rects = [r for r in page0.search_for(label) if r.y0 < 210]
    rects.sort(key=lambda r: r.y0)
    if pick >= len(rects):
        continue
    r = rects[pick]
    vals = [w for w in words
            if (r.y1 - 1) < w[1] < (r.y1 + 15) and xmin <= w[0] < xmax]
    if digits_only:
        vals = [w for w in vals if w[4].isdigit()]
    if not vals:
        continue
    for w in vals:
        geo_boxes.append(fitz.Rect(w[:4]))
    value = " ".join(w[4] for w in vals).strip()
    report[value] = kind
    # Names repeat on later pages -> search the full string everywhere.
    if "name" in kind and len(value) >= 2:
        search_terms[value] = kind

# --- 3. report -----------------------------------------------------------
print("Detected PII:")
for val, label in sorted(report.items(), key=lambda kv: kv[1]):
    print(f"  [{label}] {val}")
if not report and not geo_boxes:
    print("  (nothing detected — is this a standard 1040?)")

# --- 4. add redaction annotations ----------------------------------------
# Longest first so full strings win over substrings.
all_terms = sorted(search_terms.keys(), key=len, reverse=True)
hits = 0
for page in doc:
    for t in all_terms:
        for rect in page.search_for(t):
            page.add_redact_annot(rect, fill=(0, 0, 0)); hits += 1
for box in geo_boxes:
    page0.add_redact_annot(box, fill=(0, 0, 0)); hits += 1

print(f"\nMatched {hits} region(s) across {doc.page_count} page(s).")

if dryrun:
    print("Dry run: nothing written.")
    sys.exit(0)

# --- 5. burn it in -------------------------------------------------------
for page in doc:
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
doc.save(outp, garbage=4, deflate=True)
print(f"Wrote: {outp}")

# --- 6. verify nothing leaked back into the text layer -------------------
chk = fitz.open(outp)
leaks = [t for t in all_terms if any(chk[p].search_for(t) for p in range(chk.page_count))]
if leaks:
    print("WARNING: still present in output text layer:", leaks)
    sys.exit(1)
print("Verified: no detected PII remains in the output text layer.")
PYEOF
