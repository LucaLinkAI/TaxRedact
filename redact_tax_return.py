#!/usr/bin/env python3
"""
Redact sensitive information from a tax-return PDF.

Performs *true* redaction with PyMuPDF: matched text is physically removed from
the PDF content stream (not just covered), then a black box is drawn over the
spot. The output cannot be un-redacted by copy/paste or by removing an overlay.

What it redacts:
  * Auto-detected by regex on every page:
      - SSN / ITIN            (123-45-6789, 123 45 6789, 123456789)
      - EIN                   (12-3456789)
      - Phone numbers         ((206) 555-1234, 206-555-1234, etc.)
      - Email addresses
      - Bank account / routing numbers (runs of 9-17 digits)
  * Explicit terms you pass in (names, street address, city, ZIP, DOB, ...)
    via --term (repeatable) or --terms-file (one term per line).

Usage:
  python3 redact_tax_return.py INPUT.pdf
  python3 redact_tax_return.py INPUT.pdf -o OUTPUT.pdf \
      --term "NIANNIAN CHEN" --term "5101 145TH PL SE" \
      --term BELLEVUE --term 98006
  python3 redact_tax_return.py INPUT.pdf --terms-file pii.txt
  python3 redact_tax_return.py INPUT.pdf --dry-run    # report only, no output

Requires: PyMuPDF  (pip install pymupdf)
"""

import argparse
import re
import sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF is required. Install with:  pip install pymupdf")

# ---------------------------------------------------------------------------
# Regex patterns for values that follow a predictable shape.
# Order matters: more specific patterns first so digit-runs don't swallow SSNs.
# ---------------------------------------------------------------------------
PATTERNS = {
    "SSN/ITIN":   re.compile(r"\b\d{3}[-\s]\d{2}[-\s]\d{4}\b"),
    "EIN":        re.compile(r"\b\d{2}-\d{7}\b"),
    "Email":      re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    "Phone":      re.compile(r"(?<!\d)(?:\(\d{3}\)\s*|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?!\d)"),
    "Account#":   re.compile(r"\b\d{9,17}\b"),
}


def find_regex_terms(doc):
    """Return {label: set(matched strings)} found anywhere in the document."""
    found = {}
    for page in doc:
        text = page.get_text()
        for label, rx in PATTERNS.items():
            for m in rx.findall(text):
                # findall returns the match for non-grouped patterns
                val = m if isinstance(m, str) else m[0]
                found.setdefault(label, set()).add(val.strip())
    return found


def redact_terms(doc, terms):
    """Add redaction annotations for every literal term, return total hit count."""
    total = 0
    for page in doc:
        for term in terms:
            if not term:
                continue
            for rect in page.search_for(term):
                page.add_redact_annot(rect, fill=(0, 0, 0))
                total += 1
    return total


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="path to the source PDF")
    ap.add_argument("-o", "--output", help="output path "
                    "(default: <input>_redacted.pdf)")
    ap.add_argument("--term", action="append", default=[],
                    help="literal string to redact (repeatable)")
    ap.add_argument("--terms-file",
                    help="file with one literal term to redact per line")
    ap.add_argument("--no-auto", action="store_true",
                    help="disable regex auto-detection (only redact --term values)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be redacted; write nothing")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.exists():
        sys.exit(f"Input not found: {src}")
    out = Path(args.output) if args.output else src.with_name(src.stem + "_redacted.pdf")

    # Gather explicit terms.
    terms = list(args.term)
    if args.terms_file:
        terms += [ln.strip() for ln in Path(args.terms_file).read_text().splitlines()
                  if ln.strip()]

    doc = fitz.open(src)

    # Auto-detect regex-shaped PII and fold it into the term list.
    if not args.no_auto:
        detected = find_regex_terms(doc)
        print("Auto-detected PII:")
        if detected:
            for label, vals in detected.items():
                for v in sorted(vals):
                    print(f"  [{label}] {v}")
                    terms.append(v)
        else:
            print("  (none)")

    # De-duplicate, redact longest-first so a full string wins over substrings.
    terms = sorted(set(terms), key=len, reverse=True)
    print("\nExplicit terms to redact:")
    for t in terms:
        print(f"  {t!r}")

    hits = redact_terms(doc, terms)
    print(f"\nMatched {hits} region(s) across {doc.page_count} page(s).")

    if args.dry_run:
        print("Dry run: no file written.")
        return

    # Physically remove the matched text and burn in the black boxes.
    for page in doc:
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    doc.save(out, garbage=4, deflate=True)
    print(f"Wrote redacted PDF: {out}")

    # Verify nothing leaked back into the text layer.
    check = fitz.open(out)
    leaks = []
    for t in terms:
        for page in check:
            if t and page.search_for(t):
                leaks.append(t)
                break
    if leaks:
        print("WARNING: these terms still appear in the output text layer:")
        for t in leaks:
            print(f"  {t!r}")
    else:
        print("Verified: no redacted term remains in the output text layer.")


if __name__ == "__main__":
    main()
