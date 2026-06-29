// UI wiring for the client-side tax-PDF redactor. mupdf.js is loaded lazily on
// first use so the (sizable) WASM module isn't fetched until someone actually
// redacts a file.
import { redactPdf } from "./redact.js";

const drop = document.getElementById("drop");
const file = document.getElementById("file");
const name = document.getElementById("name");
const go = document.getElementById("go");
const status = document.getElementById("status");

let mupdfPromise = null;
const loadMupdf = () => (mupdfPromise ??= import("mupdf"));

function setStatus(kind, html) {
  status.className = `status show ${kind}`;
  status.innerHTML = html;
}

function showFile() {
  if (file.files.length) {
    name.textContent = "📄 " + file.files[0].name;
    go.disabled = false;
  } else {
    name.textContent = "";
    go.disabled = true;
  }
}

file.addEventListener("change", showFile);

["dragenter", "dragover"].forEach((e) =>
  drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("hover"); }));
["dragleave", "drop"].forEach((e) =>
  drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("hover"); }));
drop.addEventListener("drop", (ev) => {
  if (ev.dataTransfer.files.length) { file.files = ev.dataTransfer.files; showFile(); }
});

function download(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

go.addEventListener("click", async () => {
  const f = file.files[0];
  if (!f) return;
  go.disabled = true;
  setStatus("busy", "⏳ Loading redaction engine and processing… this stays on your device.");
  // Yield once so the busy status paints before the synchronous WASM work.
  await new Promise((r) => setTimeout(r, 50));

  try {
    const mupdf = await loadMupdf();
    const input = new Uint8Array(await f.arrayBuffer());
    if (!new TextDecoder().decode(input.slice(0, 5)).startsWith("%PDF")) {
      setStatus("err", "That doesn't look like a PDF file.");
      go.disabled = false;
      return;
    }

    const res = redactPdf(mupdf, input, { verify: true });
    const stem = f.name.replace(/\.pdf$/i, "") || "return";
    download(res.bytes, `${stem}_redacted.pdf`);

    const count = Object.keys(res.detected).length;
    if (res.leaks.length) {
      setStatus("warn",
        `Redacted ${count} PII value(s) across ${res.regions} region(s), but the ` +
        `leak check found text that may still remain. <strong>Review the output ` +
        `carefully before sharing.</strong>`);
    } else if (count === 0) {
      setStatus("warn",
        "No PII was detected — this may not be a standard 1040 PDF, or it may be " +
        "a scanned/image-based document where text can't be searched. " +
        "A copy still downloaded; review it before sharing.");
    } else {
      setStatus("ok",
        `✅ Redacted ${count} PII value(s) across ${res.regions} region(s) and ` +
        `verified none remain in the text layer. Your download has started.`);
    }
  } catch (err) {
    console.error(err);
    setStatus("err", `Could not process this PDF: ${err.message || err}`);
  } finally {
    go.disabled = false;
  }
});
