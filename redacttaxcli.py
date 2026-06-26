#!/usr/bin/env python3
"""RedactTaxCLI — redact all PII from tax-return PDFs.

Performs *true* redaction with PyMuPDF: matched content is physically removed
from the PDF (not merely covered), so it cannot be recovered by copy/paste,
text selection, or stripping an overlay. A black box is drawn over each spot.

Detects:
  * Regex on every page (any tax PDF):
      SSN/ITIN, EIN, phone, email, bank account/routing numbers (9-17 digits)
  * 1040 header fields by form layout:
      taxpayer + spouse names, home street, city, ZIP
    (names are also chased through every page; they repeat in e-file headers)

Examples:
  RedactTaxCLI return.pdf
  RedactTaxCLI return.pdf -o clean.pdf
  RedactTaxCLI *.pdf                 # batch; writes <name>_redacted.pdf each
  RedactTaxCLI TaxFiles/             # batch every *.pdf in a directory
  RedactTaxCLI TaxFiles/ -r          # ...recursing into subdirectories
  RedactTaxCLI return.pdf --dry-run  # report only, write nothing
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover
    sys.exit("RedactTaxCLI requires PyMuPDF.  Install with:  pip install pymupdf")

__version__ = "1.0.0"

# Regex-shaped PII: specific enough to safely search every page.
PATTERNS = {
    "SSN/ITIN": re.compile(r"\b\d{3}[-\s]\d{2}[-\s]\d{4}\b"),
    "EIN":      re.compile(r"\b\d{2}-\d{7}\b"),
    "Email":    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    "Phone":    re.compile(r"(?<!\d)(?:\(\d{3}\)\s*|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?!\d)"),
    "Account#": re.compile(r"\b\d{9,17}\b"),
}

# Public agency numbers / placeholders that are NOT taxpayer PII.
WHITELIST = {
    "800-829-4477", "800-772-1213", "800-829-1040", "800-829-3676",
    "1-800-829-4477", "1-800-772-1213",
    "00-0000000",  # blank EIN placeholder
}

# 1040 header fields: (label, x-min, x-max, occurrence, digits-only, kind)
HEADER_FIELDS = [
    ("Your first name",  38, 235, 0, False, "first name"),
    ("Last name",       235, 465, 0, False, "last name"),
    ("If joint return",  38, 235, 0, False, "spouse first name"),
    ("Last name",       235, 465, 1, False, "spouse last name"),
    ("Home address",     38, 460, 0, False, "street"),
    ("City, town",       38, 335, 0, False, "city"),
    ("ZIP code",        400, 488, 0, True,  "zip"),
]


@dataclass
class Result:
    detected: dict = field(default_factory=dict)  # value -> label
    regions: int = 0
    pages: int = 0
    leaks: list = field(default_factory=list)
    output: Path | None = None


def _detect_regex(doc):
    """Return {value: label} for regex-shaped PII across the document."""
    found = {}
    for page in doc:
        text = page.get_text()
        for label, rx in PATTERNS.items():
            for m in rx.findall(text):
                v = m.strip()
                if v not in WHITELIST:
                    found[v] = label
    return found


def _find_1040_page(doc):
    """Index of the page holding the 1040 header, or None."""
    for i, page in enumerate(doc):
        if "Your first name and middle initial" in page.get_text():
            return i
    return None


def _detect_header(doc):
    """Extract 1040 header values.

    Returns (report, search_terms, geo_page, geo_boxes). The full field strings
    (names, street, city, ZIP) are searched across every page because they
    recur on the cover sheet and each schedule's 'Name(s) shown' header.
    """
    report, search_terms, geo_boxes = {}, {}, []
    idx = _find_1040_page(doc)
    if idx is None:
        return report, search_terms, None, geo_boxes
    page = doc[idx]
    words = page.get_text("words")
    for label, xmin, xmax, pick, digits_only, kind in HEADER_FIELDS:
        rects = sorted((r for r in page.search_for(label) if r.y0 < 260),
                       key=lambda r: r.y0)
        if pick >= len(rects):
            continue
        r = rects[pick]
        vals = [w for w in words
                if (r.y1 - 1) < w[1] < (r.y1 + 15) and xmin <= w[0] < xmax]
        if digits_only:
            vals = [w for w in vals if w[4].isdigit()]
        if not vals:
            continue
        geo_boxes.extend(fitz.Rect(w[:4]) for w in vals)
        value = " ".join(w[4] for w in vals).strip()
        if len(value) >= 2:
            report[value] = kind
            search_terms[value] = kind
    return report, search_terms, idx, geo_boxes


def redact_pdf(src: Path, dst: Path, *, dry_run=False, verify=True) -> Result:
    """Redact one PDF. Returns a Result; writes dst unless dry_run."""
    doc = fitz.open(src)
    res = Result(pages=doc.page_count)

    regex_terms = _detect_regex(doc)
    header_report, header_terms, geo_page, geo_boxes = _detect_header(doc)

    res.detected = {**regex_terms, **header_report}
    search_terms = {**regex_terms, **header_terms}

    ordered = sorted(search_terms, key=len, reverse=True)  # full strings first
    for page in doc:
        for term in ordered:
            for rect in page.search_for(term):
                page.add_redact_annot(rect, fill=(0, 0, 0))
                res.regions += 1
    if geo_page is not None:
        for box in geo_boxes:
            doc[geo_page].add_redact_annot(box, fill=(0, 0, 0))
            res.regions += 1

    if dry_run:
        return res

    for page in doc:
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
    dst.parent.mkdir(parents=True, exist_ok=True)
    doc.save(dst, garbage=4, deflate=True)
    res.output = dst

    if verify:
        chk = fitz.open(dst)
        res.leaks = [t for t in ordered
                     if any(chk[p].search_for(t) for p in range(chk.page_count))]
    return res


def _print_result(src: Path, res: Result, dry_run: bool, quiet: bool):
    if quiet:
        return
    print(f"\n=== {src.name} ===")
    print("Detected PII:")
    if res.detected:
        for val, label in sorted(res.detected.items(), key=lambda kv: kv[1]):
            print(f"  [{label}] {val}")
    else:
        print("  (none — is this a standard 1040 PDF?)")
    print(f"Matched {res.regions} region(s) across {res.pages} page(s).")
    if dry_run:
        print("Dry run: nothing written.")
    elif res.output:
        print(f"Wrote: {res.output}")
        if res.leaks:
            print(f"WARNING: still in text layer: {res.leaks}")
        else:
            print("Verified: no detected PII remains in the output text layer.")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="RedactTaxCLI", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", metavar="PDF",
                    help="one or more tax-return PDFs, or directories of PDFs")
    ap.add_argument("-o", "--output",
                    help="output path (only valid with a single input PDF)")
    ap.add_argument("-r", "--recursive", action="store_true",
                    help="recurse into subdirectories of any input directory")
    ap.add_argument("--suffix", default="_redacted",
                    help="suffix for batch outputs (default: _redacted)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report detected PII without writing files")
    ap.add_argument("--no-verify", action="store_true",
                    help="skip the post-redaction text-layer leak check")
    ap.add_argument("-q", "--quiet", action="store_true",
                    help="suppress per-file reports")
    ap.add_argument("--version", action="version",
                    version=f"RedactTaxCLI {__version__}")
    args = ap.parse_args(argv)

    raw = [Path(p) for p in args.inputs]
    missing = [p for p in raw if not p.exists()]
    if missing:
        print("Not found: " + ", ".join(str(p) for p in missing), file=sys.stderr)
        return 1

    # Expand any directory into the PDFs it contains; keep files as-is.
    # Skip already-redacted outputs so re-running over a folder is idempotent.
    inputs = []
    for p in raw:
        if p.is_dir():
            pdfs = sorted(p.rglob("*.pdf") if args.recursive else p.glob("*.pdf"))
            pdfs = [f for f in pdfs if not f.stem.endswith(args.suffix)]
            if not pdfs:
                print(f"No PDFs found in directory: {p}", file=sys.stderr)
            inputs.extend(pdfs)
        else:
            inputs.append(p)
    if not inputs:
        print("No PDF inputs to process.", file=sys.stderr)
        return 1
    if args.output and len(inputs) > 1:
        print("-o/--output cannot be used with multiple inputs.", file=sys.stderr)
        return 2

    exit_code = 0
    for src in inputs:
        dst = (Path(args.output) if args.output
               else src.with_name(src.stem + args.suffix + ".pdf"))
        try:
            res = redact_pdf(src, dst, dry_run=args.dry_run,
                             verify=not args.no_verify)
        except Exception as exc:  # keep batch going; flag failure
            print(f"ERROR redacting {src.name}: {exc}", file=sys.stderr)
            exit_code = 1
            continue
        _print_result(src, res, args.dry_run, args.quiet)
        if res.leaks:
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
