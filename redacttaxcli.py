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
  * Schedule K-1 recipient block (partner / shareholder / beneficiary):
      name, street, city, ZIP
  * Letter-style address blocks (cover letters): name line, street, city/ZIP
  Names and addresses found anywhere are then chased through every page (and,
  in a batch, every file): full strings, and each name word on its own, so a
  first name alone ("Dear Kevin") is caught too.

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
    import pymupdf as fitz
except ImportError:  # pragma: no cover  (PyMuPDF < 1.24 only ships "fitz")
    try:
        import fitz
    except ImportError:
        fitz = None
if fitz is None:  # pragma: no cover
    sys.exit("RedactTaxCLI requires PyMuPDF.  Install with:  pip install pymupdf")

__version__ = "1.1.0"

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


# --- learned PII: names and addresses, matched word-by-word ---------------
# Learned values are stored as normalized token phrases ("kevin liantono") so
# they match regardless of case, punctuation, or spacing ("Seattle, WA  98107"
# vs "SEATTLE WA 98107"). Single tokens only match whole, capitalized words, so
# a first name like "Will" doesn't wipe out the verb "will".

US_STATES = set("""AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA
MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI
WY PR VI GU AS MP""".split())

# Words that mark a line as an organization, not a person.
ENTITY_WORDS = set("""llc lp llp pllc plc inc corp corporation company co ltd partners
partnership trust estate fund bank cpa cpas pc pa group associates holdings services
department treasury irs internal revenue service university foundation the of""".split())

# Honorifics / suffixes / joiners that are not identifying on their own.
NAME_STOP = set("and jr sr ii iii iv mr mrs ms dr".split())

# Form-label words that can sit where a value is expected.
LABEL_WORDS = set("street city state zip code name address".split())

# K-1 recipient labels ("Partner's Name", "Shareholder's name, address, ...").
K1_NAME_LABELS = [("partners", "name"), ("shareholders", "name"),
                  ("beneficiarys", "name")]

CSZ_RX = re.compile(r"^(?P<city>[A-Za-z][A-Za-z .'-]*?),?\s+(?P<st>[A-Z]{2})\s+"
                    r"(?P<zip>\d{5})(?:-\d{4})?$")
STREET_RX = re.compile(r"^(\d+[A-Za-z]?\s+\S|P\.?\s*O\.?\s*Box\b)", re.I)


def _norm(s):
    return re.sub(r"[\W_]+", "", s.lower())


def _capitalized(s):
    for ch in s:
        if ch.isalpha():
            return ch.isupper()
        if ch.isdigit():
            return True
    return False


@dataclass
class Word:
    rect: object  # fitz.Rect
    text: str
    norm: str
    line: tuple


def _words(page):
    return [Word(fitz.Rect(w[:4]), w[4], _norm(w[4]), (w[5], w[6]))
            for w in page.get_text("words")]


def _lines(words):
    """Group words into text lines: [(rect, text, [words])]."""
    out = {}
    for w in words:
        out.setdefault(w.line, []).append(w)
    lines = []
    for ws in out.values():
        r = fitz.Rect(ws[0].rect)
        for w in ws[1:]:
            r |= w.rect
        lines.append((r, " ".join(w.text for w in ws), ws))
    return lines


def _learn(learned, kind, text):
    """Add a name/address value (and, for names, each word) to `learned`."""
    toks = [t for t in (_norm(x) for x in text.split()) if t]
    if not toks or len("".join(toks)) < 2:
        return
    learned.setdefault(" ".join(toks), (kind, text.strip()))
    if kind == "name":
        for t in toks:
            if len(t) >= 2 and t not in NAME_STOP and not t.isdigit():
                learned.setdefault(t, (kind, t.capitalize()))
    if kind == "city/state/zip":
        m = CSZ_RX.match(" ".join(text.split()))
        if m:
            _learn(learned, "city", m["city"])
            _learn(learned, "zip", m["zip"])


def _row_below(words, anchor, *, x_max=1e9, skip=()):
    """Words on the first text row under `anchor`, left-aligned with it."""
    cand = [w for w in words if w.norm and w not in skip
            and anchor.y1 - 1 < (w.rect.y0 + w.rect.y1) / 2 < anchor.y1 + 20
            and anchor.x0 - 14 <= w.rect.x0 < x_max]
    if not cand:
        return []
    top = min(w.rect.y0 for w in cand)
    row = sorted((w for w in cand if w.rect.y0 < top + 4), key=lambda w: w.rect.x0)
    if row[0].rect.x0 > anchor.x0 + 80:
        return []
    out = [row[0]]
    for w in row[1:]:  # stop at a wide gap (next column / next cell)
        if w.rect.x0 - out[-1].rect.x1 > 25:
            break
        out.append(w)
    if all(w.norm in LABEL_WORDS for w in out):
        return []
    return out


def _find_seq(words, seq):
    """Yield index ranges of consecutive (non-empty) words matching seq."""
    idx = [i for i, w in enumerate(words) if w.norm]
    for k in range(len(idx) - len(seq) + 1):
        if all(words[idx[k + j]].norm == seq[j] for j in range(len(seq))):
            yield [idx[k + j] for j in range(len(seq))], (
                idx[k + len(seq)] if k + len(seq) < len(idx) else None)


def _union(ws):
    r = fitz.Rect(ws[0].rect)
    for w in ws[1:]:
        r |= w.rect
    return r


def _detect_k1(words, learned):
    """Schedule K-1 recipient name/address, found by label position."""
    for seq in K1_NAME_LABELS:
        for hit, nxt in _find_seq(words, seq):
            lab = _union([words[i] for i in hit])
            if nxt is not None and words[nxt].norm == "address":
                # Older combined box: name / street / city, ST ZIP stacked.
                anchor = _union([words[i] for i in hit] + [words[nxt]])
                anchor = fitz.Rect(lab.x0, anchor.y0, anchor.x1, anchor.y1)
                for n in range(4):
                    row = _row_below(words, anchor)
                    if not row:
                        break
                    text = " ".join(w.text for w in row)
                    kind = ("name" if n == 0 else "city/state/zip"
                            if CSZ_RX.match(" ".join(text.split())) else "street")
                    _learn(learned, kind, text)
                    anchor = fitz.Rect(lab.x0, anchor.y0, anchor.x1, _union(row).y1)
                continue
            row = _row_below(words, lab)
            if row:
                _learn(learned, "name", " ".join(w.text for w in row))
            # 2025+ layout: separate Street / City / State / ZIP cells below.
            fields = [w for w in words
                      if w.norm in ("street", "city", "state", "zip")
                      and lab.y1 < w.rect.y0 < lab.y1 + 100
                      and lab.x0 - 30 <= w.rect.x0 < lab.x0 + 250]
            for f in fields:
                if f.norm == "state":
                    continue
                right = [g.rect.x0 for g in fields
                         if abs(g.rect.y0 - f.rect.y0) < 3 and g.rect.x0 > f.rect.x1]
                row = _row_below(words, f.rect, x_max=min(right, default=1e9),
                                 skip=fields)
                if f.norm == "zip":
                    row = [w for w in row if re.fullmatch(r"\d{5}(-\d{4})?", w.text)]
                if row:
                    _learn(learned, f.norm, " ".join(w.text for w in row))


def _looks_like_person(text):
    toks = text.replace(",", " ").split()
    if not 2 <= len(toks) <= 5 or any(ch.isdigit() for ch in text):
        return False
    if any(_norm(t) in ENTITY_WORDS for t in toks):
        return False
    return all(re.fullmatch(r"[A-Za-z][A-Za-z.'-]*|&", t) for t in toks)


def _detect_address_blocks(words, learned):
    """Letter-style blocks: [name] / street / City, ST ZIP (cover letters)."""
    lines = _lines(words)

    def above(r):
        best = None
        for lr, text, _ in lines:
            gap = r.y0 - lr.y1
            if abs(lr.x0 - r.x0) < 25 and -2 < gap < 1.5 * r.height:
                if best is None or lr.y1 > best[0].y1:
                    best = (lr, text)
        return best

    for r, text, _ in lines:
        m = CSZ_RX.match(" ".join(text.split()))
        if not m or m["st"] not in US_STATES:
            continue
        street = above(r)
        if not street or not STREET_RX.match(street[1].strip()):
            continue
        _learn(learned, "city/state/zip", text)
        _learn(learned, "street", street[1])
        name = above(street[0])
        if name and _looks_like_person(name[1]):
            _learn(learned, "name", name[1])


def _detect_learned(doc, header_report):
    """Names/addresses from the 1040 header, K-1s and address blocks.

    Returns {normalized phrase: (kind, display text)}.
    """
    learned = {}
    for value, kind in header_report.items():
        if kind in ("first name", "last name", "spouse first name", "spouse last name"):
            _learn(learned, "name", value)
        else:
            _learn(learned, kind, value)
    for page in doc:
        words = _words(page)
        _detect_k1(words, learned)
        _detect_address_blocks(words, learned)
    return learned


def _match_learned(words, learned):
    """Rects of words matching any learned phrase (whole words only)."""
    idx = [i for i, w in enumerate(words) if w.norm]
    rects = []
    for key in learned:
        seq = key.split(" ")
        n = len(seq)
        for k in range(len(idx) - n + 1):
            ws = [words[idx[k + j]] for j in range(n)]
            if n == 1:
                w, t = ws[0], seq[0]
                ok = w.norm == t or (len(t) == 5 and t.isdigit() and len(w.norm) == 9
                                     and w.norm.isdigit() and w.norm.startswith(t))
                if not ok or not _capitalized(w.text):
                    continue
            elif any(w.norm != t for w, t in zip(ws, seq)):
                continue
            rects.extend(w.rect for w in ws)
    return rects


def detect_learned(src: Path):
    """Names/addresses in one PDF (batch pass 1, shared across files)."""
    doc = fitz.open(src)
    try:
        header_report, *_ = _detect_header(doc)
        return _detect_learned(doc, header_report)
    finally:
        doc.close()


def _tight(rect):
    """Trim a hit box vertically: MuPDF removes every glyph a redaction rect
    touches, and tall word boxes can graze the lines above and below."""
    r = fitz.Rect(rect)
    pad = r.height * 0.2
    return fitz.Rect(r.x0, r.y0 + pad, r.x1, r.y1 - pad)


def redact_pdf(src: Path, dst: Path, *, dry_run=False, verify=True,
               shared=None) -> Result:
    """Redact one PDF. Returns a Result; writes dst unless dry_run.

    `shared` is an optional {phrase: (kind, text)} of names/addresses learned
    from other files in the same batch, redacted here too.
    """
    doc = fitz.open(src)
    res = Result(pages=doc.page_count)

    regex_terms = _detect_regex(doc)
    header_report, header_terms, geo_page, geo_boxes = _detect_header(doc)
    learned = _detect_learned(doc, header_report)
    own = set(learned)
    for key, val in (shared or {}).items():
        learned.setdefault(key, val)

    res.detected = {**regex_terms, **header_report,
                    **{text: kind for key, (kind, text) in learned.items()
                       if key in own}}
    search_terms = {**regex_terms, **header_terms}

    ordered = sorted(search_terms, key=len, reverse=True)  # full strings first
    for page in doc:
        for term in ordered:
            for rect in page.search_for(term):
                page.add_redact_annot(_tight(rect), fill=(0, 0, 0))
                res.regions += 1
        for rect in _match_learned(_words(page), learned):
            page.add_redact_annot(_tight(rect), fill=(0, 0, 0))
            res.regions += 1
    if geo_page is not None:
        for box in geo_boxes:
            doc[geo_page].add_redact_annot(_tight(box), fill=(0, 0, 0))
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
        for p in range(chk.page_count):
            words = _words(chk[p])
            for key, (kind, text) in learned.items():
                if _match_learned(words, {key: None}) and text not in res.leaks:
                    res.leaks.append(text)
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
    ap.add_argument("--no-share", action="store_true",
                    help="don't reuse names/addresses found in one file of a "
                         "batch when redacting the others")
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

    # Pass 1: learn names/addresses from every file, so a cover letter or a
    # schedule with no labeled header still gets the taxpayer's name redacted.
    shared = {}
    if len(inputs) > 1 and not args.no_share:
        for src in inputs:
            try:
                for key, val in detect_learned(src).items():
                    shared.setdefault(key, val)
            except Exception:  # reported again (and counted) in pass 2
                pass

    exit_code = 0
    for src in inputs:
        dst = (Path(args.output) if args.output
               else src.with_name(src.stem + args.suffix + ".pdf"))
        try:
            res = redact_pdf(src, dst, dry_run=args.dry_run,
                             verify=not args.no_verify, shared=shared)
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
