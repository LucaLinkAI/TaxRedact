// Validates the ported redaction engine in Node against real PDFs, mirroring
// the checks done for the Python CLI. Usage: node test/node_check.mjs <pdf...>
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { redactPdf } from "../src/redact.js";

function remainingText(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  let out = "";
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const st = page.toStructuredText("preserve-whitespace");
    out += st.asText();
    st.destroy();
    page.destroy();
  }
  doc.destroy();
  return out;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node test/node_check.mjs <pdf...>");
  process.exit(2);
}

let failed = false;
for (const f of files) {
  const input = new Uint8Array(readFileSync(f));
  const res = redactPdf(mupdf, input, { verify: true });
  console.log(`\n=== ${f} ===`);
  console.log("Detected PII:");
  const entries = Object.entries(res.detected);
  if (entries.length) {
    for (const [val, label] of entries.sort((a, b) => a[1].localeCompare(b[1])))
      console.log(`  [${label}] ${val}`);
  } else {
    console.log("  (none)");
  }
  console.log(`Matched ${res.regions} region(s) across ${res.pages} page(s).`);
  console.log(`Output: ${res.bytes.length} bytes`);
  if (res.leaks.length) {
    console.log("WARNING leaks:", res.leaks);
    failed = true;
  } else {
    console.log("Verified: no detected PII remains in the output text layer.");
  }
  // Cross-check: none of the detected values survive as substrings of text.
  const text = remainingText(res.bytes);
  const survivors = Object.keys(res.detected).filter((v) => text.includes(v));
  if (survivors.length) {
    console.log("FAIL substrings still present:", survivors);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
