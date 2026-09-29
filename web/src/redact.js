// Client-side tax-PDF PII redaction — a faithful port of redacttaxcli.py's
// engine to mupdf.js. Runs entirely in the browser (or Node) via WebAssembly,
// so the PDF never leaves the user's device.
//
// Same approach as the Python CLI: detect regex-shaped PII on every page, plus
// extract 1040 header fields, Schedule K-1 recipient blocks and letter-style
// address blocks (names/street/city/ZIP), add redaction annotations over every
// match, then physically apply them so the content is removed from the PDF —
// not just covered. Names/addresses are chased through every page (and, in a
// batch, every file) word-by-word, so a first name alone is caught too.

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

// mupdf.js >= 1.28 searches case-sensitively unless told otherwise; PyMuPDF's
// search_for is case-insensitive, so match it.
const SEARCH = "ignore-case";

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
// Each word also carries its normalized form and a line id (like PyMuPDF's
// block/line numbers) for the name/address matching below.
function getWords(page) {
  const st = page.toStructuredText("preserve-whitespace");
  const words = [];
  let cur = null;
  let line = 0;
  const flush = () => {
    if (cur) { cur.norm = norm(cur.text); cur.line = line; words.push(cur); }
    cur = null;
  };
  st.walk({
    beginLine() { flush(); line++; },
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
    const rects = page.search(label, SEARCH)
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


// --- learned PII: names and addresses, matched word-by-word -----------------
// Mirrors redacttaxcli.py. Learned values are stored as normalized token
// phrases ("jane doe") so they match regardless of case, punctuation or
// spacing. Single tokens only match whole, capitalized words, so a first name
// like "Will" doesn't wipe out the verb "will".

const US_STATES = new Set(`AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA
ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT
VA WA WV WI WY PR VI GU AS MP`.split(/\s+/));

// Words that mark a line as an organization, not a person.
const ENTITY_WORDS = new Set(`llc lp llp pllc plc inc corp corporation company co
ltd partners partnership trust estate fund bank cpa cpas pc pa group associates
holdings services department treasury irs internal revenue service university
foundation the of`.split(/\s+/));

// Honorifics / suffixes / joiners that are not identifying on their own.
const NAME_STOP = new Set("and jr sr ii iii iv mr mrs ms dr".split(" "));

// Form-label words that can sit where a value is expected.
const LABEL_WORDS = new Set("street city state zip code name address".split(" "));

// K-1 recipient labels ("Partner's Name", "Shareholder's name, address, ...").
const K1_NAME_LABELS = [["partners", "name"], ["shareholders", "name"],
                        ["beneficiarys", "name"]];

const CSZ_RX = /^([A-Za-z][A-Za-z .'-]*?),?\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/;
const STREET_RX = /^(\d+[A-Za-z]?\s+\S|P\.?\s*O\.?\s*Box\b)/i;

const squash = (s) => s.split(/\s+/).filter(Boolean).join(" ");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function norm(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function capitalized(s) {
  const m = s.match(/[\p{L}\p{N}]/u);
  return !!m && (/\p{N}/u.test(m[0]) || m[0] !== m[0].toLowerCase());
}

const rectOf = (w) => [w.x0, w.y0, w.x1, w.y1];
const unionWords = (ws) => ws.map(rectOf).reduce(unionRect);

// Group words into text lines: [{ rect, text, words }].
function getLines(words) {
  const byLine = new Map();
  for (const w of words) {
    if (!byLine.has(w.line)) byLine.set(w.line, []);
    byLine.get(w.line).push(w);
  }
  return [...byLine.values()].map((ws) => ({
    rect: unionWords(ws), text: ws.map((w) => w.text).join(" "), words: ws,
  }));
}

// Add a name/address value (and, for names, each word) to `learned`.
function learn(learned, kind, text) {
  const toks = text.split(/\s+/).map(norm).filter(Boolean);
  if (!toks.length || toks.join("").length < 2) return;
  const key = toks.join(" ");
  if (!(key in learned)) learned[key] = [kind, text.trim()];
  if (kind === "name") {
    for (const t of toks) {
      if (t.length >= 2 && !NAME_STOP.has(t) && !/^\d+$/.test(t) && !(t in learned))
        learned[t] = [kind, cap(t)];
    }
  }
  if (kind === "city/state/zip") {
    const m = squash(text).match(CSZ_RX);
    if (m) { learn(learned, "city", m[1]); learn(learned, "zip", m[3]); }
  }
}

// Words on the first text row under `anchor`, left-aligned with it.
function rowBelow(words, anchor, { xMax = 1e9, skip = [] } = {}) {
  const [ax0, , , ay1] = anchor;
  const cand = words.filter((w) => w.norm && !skip.includes(w) &&
    ay1 - 1 < (w.y0 + w.y1) / 2 && (w.y0 + w.y1) / 2 < ay1 + 20 &&
    ax0 - 14 <= w.x0 && w.x0 < xMax);
  if (!cand.length) return [];
  const top = Math.min(...cand.map((w) => w.y0));
  const row = cand.filter((w) => w.y0 < top + 4).sort((a, b) => a.x0 - b.x0);
  if (row[0].x0 > ax0 + 80) return [];
  const out = [row[0]];
  for (const w of row.slice(1)) { // stop at a wide gap (next column / cell)
    if (w.x0 - out[out.length - 1].x1 > 25) break;
    out.push(w);
  }
  return out.every((w) => LABEL_WORDS.has(w.norm)) ? [] : out;
}

// Index ranges of consecutive (non-empty) words matching seq.
function* findSeq(words, seq) {
  const idx = [];
  words.forEach((w, i) => { if (w.norm) idx.push(i); });
  for (let k = 0; k + seq.length <= idx.length; k++) {
    if (seq.every((t, j) => words[idx[k + j]].norm === t)) {
      yield [idx.slice(k, k + seq.length),
             k + seq.length < idx.length ? idx[k + seq.length] : null];
    }
  }
}

const rowText = (row) => row.map((w) => w.text).join(" ");

// Schedule K-1 recipient name/address, found by label position.
function detectK1(words, learned) {
  for (const seq of K1_NAME_LABELS) {
    for (const [hit, nxt] of findSeq(words, seq)) {
      const lab = unionWords(hit.map((i) => words[i]));
      if (nxt !== null && words[nxt].norm === "address") {
        // Older combined box: name / street / city, ST ZIP stacked.
        let anchor = unionRect(lab, rectOf(words[nxt]));
        anchor = [lab[0], anchor[1], anchor[2], anchor[3]];
        for (let n = 0; n < 4; n++) {
          const row = rowBelow(words, anchor);
          if (!row.length) break;
          const text = rowText(row);
          const kind = n === 0 ? "name"
            : CSZ_RX.test(squash(text)) ? "city/state/zip" : "street";
          learn(learned, kind, text);
          anchor = [lab[0], anchor[1], anchor[2], unionWords(row)[3]];
        }
        continue;
      }
      const row = rowBelow(words, lab);
      if (row.length) learn(learned, "name", rowText(row));
      // 2025+ layout: separate Street / City / State / ZIP cells below.
      const fields = words.filter((w) =>
        ["street", "city", "state", "zip"].includes(w.norm) &&
        lab[3] < w.y0 && w.y0 < lab[3] + 100 &&
        lab[0] - 30 <= w.x0 && w.x0 < lab[0] + 250);
      for (const f of fields) {
        if (f.norm === "state") continue;
        const right = fields
          .filter((g) => Math.abs(g.y0 - f.y0) < 3 && g.x0 > f.x1)
          .map((g) => g.x0);
        let vals = rowBelow(words, rectOf(f),
          { xMax: right.length ? Math.min(...right) : 1e9, skip: fields });
        if (f.norm === "zip") vals = vals.filter((w) => /^\d{5}(-\d{4})?$/.test(w.text));
        if (vals.length) learn(learned, f.norm, rowText(vals));
      }
    }
  }
}

function looksLikePerson(text) {
  const toks = text.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (toks.length < 2 || toks.length > 5 || /\d/.test(text)) return false;
  if (toks.some((t) => ENTITY_WORDS.has(norm(t)))) return false;
  return toks.every((t) => /^([A-Za-z][A-Za-z.'-]*|&)$/.test(t));
}

// Letter-style blocks: [name] / street / City, ST ZIP (cover letters).
function detectAddressBlocks(words, learned) {
  const lines = getLines(words);
  const above = (r) => {
    let best = null;
    const h = r[3] - r[1];
    for (const l of lines) {
      const gap = r[1] - l.rect[3];
      if (Math.abs(l.rect[0] - r[0]) < 25 && -2 < gap && gap < 1.5 * h &&
          (!best || l.rect[3] > best.rect[3])) best = l;
    }
    return best;
  };
  for (const l of lines) {
    const m = squash(l.text).match(CSZ_RX);
    if (!m || !US_STATES.has(m[2])) continue;
    const street = above(l.rect);
    if (!street || !STREET_RX.test(street.text.trim())) continue;
    learn(learned, "city/state/zip", l.text);
    learn(learned, "street", street.text);
    const name = above(street.rect);
    if (name && looksLikePerson(name.text)) learn(learned, "name", name.text);
  }
}

// Names/addresses from the 1040 header, K-1s and address blocks.
// Returns { normalizedPhrase: [kind, displayText] }.
function detectLearnedDoc(doc, headerReport) {
  const learned = {};
  const NAME_KINDS = ["first name", "last name", "spouse first name", "spouse last name"];
  for (const [value, kind] of Object.entries(headerReport))
    learn(learned, NAME_KINDS.includes(kind) ? "name" : kind, value);
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const words = getWords(page);
    detectK1(words, learned);
    detectAddressBlocks(words, learned);
    page.destroy();
  }
  return learned;
}

// Rects of words matching any learned phrase (whole words only).
function matchLearned(words, keys) {
  const idx = [];
  words.forEach((w, i) => { if (w.norm) idx.push(i); });
  const rects = [];
  for (const key of keys) {
    const seq = key.split(" ");
    const n = seq.length;
    for (let k = 0; k + n <= idx.length; k++) {
      const ws = seq.map((_, j) => words[idx[k + j]]);
      if (n === 1) {
        const [w] = ws;
        const t = seq[0];
        const ok = w.norm === t || (/^\d{5}$/.test(t) && /^\d{9}$/.test(w.norm) &&
                                    w.norm.startsWith(t));
        if (!ok || !capitalized(w.text)) continue;
      } else if (ws.some((w, j) => w.norm !== seq[j])) continue;
      for (const w of ws) rects.push(rectOf(w));
    }
  }
  return rects;
}

/**
 * Names/addresses in one PDF (batch pass 1): { phrase: [kind, text] }.
 * Merge the results of every file in a batch and pass them to redactPdf as
 * `shared`, so a cover letter or schedule with no labeled header is covered.
 */
export function detectLearned(mupdf, inputBytes) {
  const doc = mupdf.Document.openDocument(inputBytes, "application/pdf");
  try {
    return detectLearnedDoc(doc, detectHeader(doc).report);
  } finally {
    doc.destroy();
  }
}

// --- redaction --------------------------------------------------------------

// Hit boxes are trimmed vertically: MuPDF removes every glyph a redaction rect
// touches, and tall word boxes can graze the lines above and below.
function addRedaction(page, rect) {
  const pad = (rect[3] - rect[1]) * 0.2;
  const annot = page.createAnnotation("Redact");
  annot.setRect([rect[0], rect[1] + pad, rect[2], rect[3] - pad]);
}

/**
 * Redact one PDF given as a Uint8Array. Returns
 *   { bytes, detected: {value:label}, regions, pages, leaks: [terms] }.
 * `shared` is an optional { phrase: [kind, text] } of names/addresses learned
 * from other files in the same batch (see detectLearned).
 * `mupdf` is the imported module (passed in so this file stays environment-
 * agnostic — the browser and Node load the module differently).
 */
export function redactPdf(mupdf, inputBytes, { verify = true, shared = {} } = {}) {
  const doc = mupdf.Document.openDocument(inputBytes, "application/pdf");
  const pages = doc.countPages();

  const regexTerms = detectRegex(doc);
  const { report, searchTerms: headerTerms, geoPage, geoBoxes } =
    detectHeader(doc);
  const own = detectLearnedDoc(doc, report);
  const learned = { ...shared, ...own };
  const learnedKeys = Object.keys(learned);

  const detected = { ...regexTerms, ...report };
  for (const [kind, text] of Object.values(own)) detected[text] = kind;
  const searchTerms = { ...regexTerms, ...headerTerms };

  // Longest strings first, so a full value wins over a substring.
  const ordered = Object.keys(searchTerms).sort((a, b) => b.length - a.length);

  let regions = 0;
  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i);
    for (const term of ordered) {
      for (const hit of page.search(term, SEARCH)) {
        addRedaction(page, hitToRect(hit));
        regions++;
      }
    }
    for (const rect of matchLearned(getWords(page), learnedKeys)) {
      addRedaction(page, rect);
      regions++;
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
        const hits = page.search(term, SEARCH);
        page.destroy();
        if (hits.length) return true;
      }
      return false;
    });
    for (let i = 0; i < np; i++) {
      const page = chk.loadPage(i);
      const words = getWords(page);
      page.destroy();
      for (const key of learnedKeys) {
        const text = learned[key][1];
        if (!leaks.includes(text) && matchLearned(words, [key]).length) leaks.push(text);
      }
    }
    chk.destroy();
  }

  return { bytes, detected, regions, pages, leaks };
}
