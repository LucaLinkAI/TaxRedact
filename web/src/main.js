// UI wiring for the client-side tax-PDF redactor. Takes any number of PDFs or
// folders (searched recursively), redacts them as one batch — names/addresses
// learned in any file are redacted in all — and offers each result plus a zip.
// mupdf.js is loaded lazily on first use so the (sizable) WASM module isn't
// fetched until someone actually redacts a file.
import { zipSync } from "fflate";
import { detectLearned, redactPdf } from "./redact.js";
import { version as cliVersion } from "../../cli/package.json";

const $ = (id) => document.getElementById(id);
const drop = $("drop");
const filesInput = $("files");
const folderInput = $("folder");
const list = $("list");
const go = $("go");
const zipBtn = $("zip");
const status = $("status");

let mupdfPromise = null;
const loadMupdf = () => (mupdfPromise ??= import("mupdf"));

// lucide icons, inlined (no emoji in UI).
const svg = (body) =>
  `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  file: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
  busy: svg('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'),
  ok: svg('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  warn: svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  err: svg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'),
  download: svg('<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>'),
  x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
};

// Each item: { file, path, state: "idle"|"busy"|"ok"|"warn"|"err", msg, out, url }
let items = [];
let running = false;

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const outName = (path) => path.replace(/\.pdf$/i, "") + "_redacted.pdf";

function setStatus(kind, html) {
  status.className = kind ? `status show ${kind}` : "status";
  status.innerHTML = html || "";
}

function render() {
  list.innerHTML = items.map((it, i) => `
    <li class="${it.state}">
      <span class="ic">${ICON[it.state === "idle" ? "file" : it.state]}</span>
      <div class="body">
        <div class="fn">${esc(it.path)}</div>
        ${it.msg ? `<div class="meta">${esc(it.msg)}</div>` : ""}
      </div>
      ${it.url ? `<a href="${it.url}" download="${esc(outName(it.path).split("/").pop())}">${ICON.download}PDF</a>` : ""}
      ${!running && it.state === "idle" ? `<button class="x" data-i="${i}" title="Remove">${ICON.x}</button>` : ""}
    </li>`).join("");
  const pending = items.filter((it) => it.state === "idle").length;
  go.disabled = running || !pending;
  go.textContent = pending > 1 ? `Redact ${pending} files` : "Redact";
  zipBtn.hidden = items.filter((it) => it.out).length < 2;
  zipBtn.disabled = running;
}

list.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button.x");
  if (!btn || running) return;
  items.splice(Number(btn.dataset.i), 1);
  render();
});

function addFiles(entries) {
  const seen = new Set(items.map((it) => it.path));
  let skipped = 0;
  for (const { file, path } of entries) {
    if (!/\.pdf$/i.test(file.name)) { skipped++; continue; }
    if (/_redacted\.pdf$/i.test(file.name) || seen.has(path)) continue;
    seen.add(path);
    items.push({ file, path, state: "idle" });
  }
  if (skipped) setStatus("warn", `Ignored ${skipped} non-PDF file(s).`);
  render();
}

// --- inputs: file picker, folder picker, drag & drop (files or folders) ----
$("pickFiles").addEventListener("click", (e) => { e.stopPropagation(); filesInput.click(); });
$("pickFolder").addEventListener("click", (e) => { e.stopPropagation(); folderInput.click(); });
drop.addEventListener("click", () => filesInput.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); filesInput.click(); }
});
filesInput.addEventListener("change", () => {
  addFiles([...filesInput.files].map((file) => ({ file, path: file.name })));
  filesInput.value = "";
});
folderInput.addEventListener("change", () => {
  addFiles([...folderInput.files].map((file) => ({ file, path: file.webkitRelativePath || file.name })));
  folderInput.value = "";
});

// Recursively read a dropped folder via the FileSystem Entry API.
async function readEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: prefix + file.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) { // readEntries returns results in chunks until empty
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}

["dragenter", "dragover"].forEach((e) =>
  drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("hover"); }));
["dragleave", "drop"].forEach((e) =>
  drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("hover"); }));
drop.addEventListener("drop", async (ev) => {
  if (running) return;
  const entries = [...ev.dataTransfer.items]
    .map((it) => it.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) {
    addFiles([...ev.dataTransfer.files].map((file) => ({ file, path: file.name })));
    return;
  }
  const out = [];
  for (const entry of entries) await readEntry(entry, "", out);
  addFiles(out);
});

// --- downloads ---------------------------------------------------------------
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

zipBtn.addEventListener("click", () => {
  const entries = {};
  for (const it of items) if (it.out) entries[outName(it.path)] = [it.out, { level: 0 }];
  download(new Blob([zipSync(entries)], { type: "application/zip" }), "redacted.zip");
});

// --- run -----------------------------------------------------------------------
const paint = () => new Promise((r) => setTimeout(r, 30)); // let the UI repaint

go.addEventListener("click", async () => {
  const todo = items.filter((it) => it.state === "idle");
  if (!todo.length) return;
  running = true;
  render();
  setStatus("busy", "Loading redaction engine… files stay on your device.");
  await paint();

  let mupdf;
  try {
    mupdf = await loadMupdf();
  } catch (err) {
    running = false;
    render();
    setStatus("err", `Could not load the redaction engine: ${esc(String(err.message || err))}`);
    return;
  }

  // Pass 1: read every file and learn names/addresses from all of them, so a
  // cover letter or statement with no labeled form still gets them redacted.
  const shared = {};
  const bytes = new Map();
  for (const [n, it] of todo.entries()) {
    setStatus("busy", `Scanning ${n + 1} of ${todo.length} for names and addresses…`);
    it.state = "busy";
    render();
    await paint();
    try {
      const data = new Uint8Array(await it.file.arrayBuffer());
      if (!new TextDecoder().decode(data.slice(0, 5)).startsWith("%PDF")) {
        throw new Error("That doesn't look like a PDF file.");
      }
      bytes.set(it, data);
      Object.assign(shared, detectLearned(mupdf, data));
    } catch (err) {
      it.state = "err";
      it.msg = String(err.message || err);
    }
  }

  // Pass 2: redact.
  for (const [n, it] of todo.entries()) {
    if (!bytes.has(it)) continue;
    setStatus("busy", `Redacting ${n + 1} of ${todo.length}…`);
    await paint();
    try {
      const res = redactPdf(mupdf, bytes.get(it), { verify: true, shared });
      it.out = res.bytes;
      it.url = URL.createObjectURL(new Blob([res.bytes], { type: "application/pdf" }));
      const count = Object.keys(res.detected).length;
      if (res.leaks.length) {
        it.state = "warn";
        it.msg = `${res.regions} region(s) redacted, but some text may remain — review carefully.`;
      } else if (res.regions === 0) {
        it.state = "warn";
        it.msg = "Nothing detected — scanned/image PDF, or not a supported form? Review it.";
      } else {
        it.state = "ok";
        it.msg = (count ? `${count} value(s) found here, ` : "Using names/addresses from other files, ") +
          `${res.regions} region(s) redacted and verified.`;
      }
    } catch (err) {
      console.error(err);
      it.state = "err";
      it.msg = `Could not process this PDF: ${err.message || err}`;
    }
    bytes.delete(it);
    render();
  }

  running = false;
  render();
  const done = todo.filter((it) => it.out);
  const warn = todo.filter((it) => it.state === "warn").length;
  const failed = todo.filter((it) => it.state === "err").length;
  if (done.length === 1 && todo.length === 1) {
    download(new Blob([done[0].out], { type: "application/pdf" }), outName(done[0].path).split("/").pop());
  }
  const summary = `Redacted ${done.length} of ${todo.length} file(s)` +
    (warn ? `, ${warn} need a closer look` : "") + (failed ? `, ${failed} failed` : "") + ".";
  const next = done.length > 1
    ? " Use <strong>Download all (.zip)</strong> or the per-file links."
    : done.length === 1 ? " Your download has started." : "";
  setStatus(failed || warn ? "warn" : "ok", summary + next +
    (done.length ? " Review each output before sharing." : ""));
});

// --- command-line download section ---------------------------------------------
// Files are produced by `npm run build` in cli/ (web's prebuild runs it).
{
  const base = new URL(`downloads/redacttax-${cliVersion}`, location.href).href;
  $("cliVer").textContent = `v${cliVersion}`;
  $("dlTgz").href = `${base}.tgz`;
  $("dlZip").href = `${base}.zip`;
  $("cmdInstall").textContent = `npm install -g ${base}.tgz`;
  $("macInstall").textContent = `npm install -g ${base}.tgz`;
  $("macSudo").textContent = `sudo npm install -g ${base}.tgz`;
  // Open the Mac guide by default for Mac visitors.
  if (/Mac/.test(navigator.platform || navigator.userAgent)) $("macGuide").open = true;
  document.querySelectorAll("[data-copy]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($(btn.dataset.copy).textContent);
        btn.style.color = "#6ee7b7";
        setTimeout(() => { btn.style.color = ""; }, 1200);
      } catch { /* clipboard unavailable: the text is still selectable */ }
    }));
}

// --- source code download ---------------------------------------------------------
// taxredact-source.zip is a git archive of the commit this page was built from.
{
  /* global __SOURCE__ */
  const { sha, date } = __SOURCE__;
  if (sha) $("srcVer").textContent = `commit ${sha}${date ? `, ${date}` : ""}`;
  fetch($("dlSrc").href, { method: "HEAD" })
    .then((r) => {
      const n = Number(r.headers.get("content-length"));
      if (r.ok && n) $("srcSize").textContent = `${Math.max(1, Math.round(n / 1024))} KB`;
    })
    .catch(() => {});
}

render();
