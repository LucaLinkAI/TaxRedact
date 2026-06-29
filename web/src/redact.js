// Client-side tax-PDF PII redaction — a faithful port of redacttaxcli.py's
// engine to mupdf.js. Runs entirely in the browser (or Node) via WebAssembly,
// so the PDF never leaves the user's device.
//
// Same approach as the Python CLI: detect regex-shaped PII on every page, plus
// extract 1040 header fields (names/address/city/ZIP) by their position, add
// redaction annotations over every match, then physically apply them so the
// content is removed from the PDF — not just covered.

// Regex-shaped PII: specific enough to safely search every page.
const PATTERNS = {
  "SSN/ITIN": /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g,
  EIN: /\b\d{2}-\d{7}\b/g,
  Email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  Phone: /(?<!\d)(?:\(\d{3}\)\s*|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?!\d)/g,
  "Account#": /\b\d{9,17}\b/g,
};

// Public agency numbers / placeholders that are NOT taxpayer PII.
const WHITELIST = new Set([
  "800-829-4477", "800-772-1213", "800-829-1040", "800-829-3676",
  "1-800-829-4477", "1-800-772-1213",
  "00-0000000", // blank EIN placeholder
]);

// 1040 header fields: [label, xMin, xMax, occurrence, digitsOnly, kind]
const HEADER_FIELDS = [
  ["Your first name", 38, 235, 0, false, "first name"],
  ["Last name", 235, 465, 0, false, "last name"],
  ["If joint return", 38, 235, 0, false, "spouse first name"],
  ["Last name", 235, 465, 1, false, "spouse last name"],
  ["Home address", 38, 460, 0, false, "street"],
  ["City, town", 38, 335, 0, false, "city"],
  ["ZIP code", 400, 488, 0, true, "zip"],
];

// --- geometry helpers (mupdf.js uses plain number arrays) -------------------
// Rect: [x0, y0, x1, y1].  Quad: [ulx, uly, urx, ury, llx, lly, lrx, lry].

function quadToRect(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function unionRect(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]),
          Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

// Each search hit is an array of per-character Quads; merge them into one rect.
function hitToRect(hit) {
  return hit.map(quadToRect).reduce(unionRect);
}

// Reconstruct word boxes (PyMuPDF's get_text("words")) from structured text.
function getWords(page) {
  const st = page.toStructuredText("preserve-whitespace");
  const words = [];
  let cur = null;
  const flush = () => {
    if (cur) words.push(cur);
    cur = null;
  };
  st.walk({
    beginLine: flush,
    endLine: flush,
    onChar(c, _origin, _font, _size, quad) {
      if (/\s/.test(c)) { flush(); return; }
      const r = quadToRect(quad);
      if (!cur) cur = { x0: r[0], y0: r[1], x1: r[2], y1: r[3], text: "" };
      else {
        cur.x0 = Math.min(cur.x0, r[0]); cur.y0 = Math.min(cur.y0, r[1]);
        cur.x1 = Math.max(cur.x1, r[2]); cur.y1 = Math.max(cur.y1, r[3]);
      }
      cur.text += c;
    },
  });
  flush();
  st.destroy();
  return words;
}

function pageText(page) {
  const st = page.toStructuredText("preserve-whitespace");
  const text = st.asText();
  st.destroy();
  return text;
}

// --- detection --------------------------------------------------------------

function detectRegex(doc) {
  const found = {}; // value -> label
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const text = pageText(page);
    for (const [label, rx] of Object.entries(PATTERNS)) {
      rx.lastIndex = 0;
      for (const m of text.matchAll(rx)) {
        const v = m[0].trim();
        if (!WHITELIST.has(v)) found[v] = label;
      }
    }
    page.destroy();
  }
  return found;
}

function find1040Page(doc) {
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const hit = pageText(page).includes("Your first name and middle initial");
    page.destroy();
    if (hit) return i;
  }
  return null;
}

// Extract 1040 header values. Returns { report, searchTerms, geoPage, geoBoxes }.
// Full field strings recur on each schedule's "Name(s) shown" header, so they
// are searched across every page; the geometric boxes redact the header itself.
function detectHeader(doc) {
  const report = {};      // value -> kind
  const searchTerms = {}; // value -> kind
  const geoBoxes = [];    // rects on the 1040 page
  const idx = find1040Page(doc);
  if (idx === null) return { report, searchTerms, geoPage: null, geoBoxes };

  const page = doc.loadPage(idx);
  const words = getWords(page);
  for (const [label, xMin, xMax, pick, digitsOnly, kind] of HEADER_FIELDS) {
    const rects = page.search(label, 32)
      .map(hitToRect)
      .filter((r) => r[1] < 260)            // header region only
      .sort((a, b) => a[1] - b[1]);
    if (pick >= rects.length) continue;
    const r = rects[pick];
    const ry1 = r[3];
    let vals = words.filter(
      (w) => ry1 - 1 < w.y0 && w.y0 < ry1 + 15 && xMin <= w.x0 && w.x0 < xMax);
    if (digitsOnly) vals = vals.filter((w) => /^\d+$/.test(w.text));
    if (!vals.length) continue;
    for (const w of vals) geoBoxes.push([w.x0, w.y0, w.x1, w.y1]);
    const value = vals.map((w) => w.text).join(" ").trim();
    if (value.length >= 2) { report[value] = kind; searchTerms[value] = kind; }
  }
  page.destroy();
  return { report, searchTerms, geoPage: idx, geoBoxes };
}

// --- redaction --------------------------------------------------------------

function addRedaction(page, rect) {
  const annot = page.createAnnotation("Redact");
  annot.setRect(rect);
}

/**
 * Redact one PDF given as a Uint8Array. Returns
 *   { bytes, detected: {value:label}, regions, pages, leaks: [terms] }.
 * `mupdf` is the imported module (passed in so this file stays environment-
 * agnostic — the browser and Node load the module differently).
 */
export function redactPdf(mupdf, inputBytes, { verify = true } = {}) {
  const doc = mupdf.Document.openDocument(inputBytes, "application/pdf");
  const pages = doc.countPages();

  const regexTerms = detectRegex(doc);
  const { report, searchTerms: headerTerms, geoPage, geoBoxes } =
    detectHeader(doc);

  const detected = { ...regexTerms, ...report };
  const searchTerms = { ...regexTerms, ...headerTerms };

  // Longest strings first, so a full value wins over a substring.
  const ordered = Object.keys(searchTerms).sort((a, b) => b.length - a.length);

  let regions = 0;
  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i);
    for (const term of ordered) {
      for (const hit of page.search(term, 64)) {
        addRedaction(page, hitToRect(hit));
        regions++;
      }
    }
    if (i === geoPage) {
      for (const box of geoBoxes) { addRedaction(page, box); regions++; }
    }
    page.applyRedactions(true); // true => burn a black box over each spot
    page.destroy();
  }

  const buf = doc.saveToBuffer("garbage=4,compress=yes");
  const bytes = buf.asUint8Array().slice(); // copy out before freeing WASM mem
  buf.destroy();
  doc.destroy();

  let leaks = [];
  if (verify) {
    const chk = mupdf.Document.openDocument(bytes, "application/pdf");
    const np = chk.countPages();
    leaks = ordered.filter((term) => {
      for (let i = 0; i < np; i++) {
        const page = chk.loadPage(i);
        const hits = page.search(term, 1);
        page.destroy();
        if (hits.length) return true;
      }
      return false;
    });
    chk.destroy();
  }

  return { bytes, detected, regions, pages, leaks };
}
