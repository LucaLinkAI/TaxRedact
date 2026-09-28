// Ink (React for the terminal) UI: a live per-file list while the batch runs,
// then a summary. Written with createElement so there's no JSX build step.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import React, { useEffect, useState } from "react";
import { Box, Static, Text, useApp } from "ink";
import * as mupdf from "mupdf";
import { detectLearned, redactPdf } from "../../web/src/redact.js";

const h = React.createElement;

// The engine is synchronous WASM work; yield so Ink can repaint between files.
const tick = () => new Promise((r) => setTimeout(r, 0));

const SPIN = ["|", "/", "-", "\\"];

function kindSummary(detected) {
  const counts = {};
  for (const kind of Object.values(detected)) counts[kind] = (counts[kind] || 0) + 1;
  return Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ");
}

function FileLine({ job, frame }) {
  const { state, src, dst, res, error } = job;
  const mark = {
    pending: h(Text, { color: "gray" }, "·"),
    scanning: h(Text, { color: "cyan" }, SPIN[frame % 4]),
    working: h(Text, { color: "cyan" }, SPIN[frame % 4]),
    ok: h(Text, { color: "green" }, "✓"),
    warn: h(Text, { color: "yellow" }, "!"),
    error: h(Text, { color: "red" }, "✗"),
  }[state];
  const lines = [h(Box, { key: "head", gap: 1 }, mark, h(Text, { bold: state !== "pending" }, src))];
  if (error) lines.push(h(Text, { key: "err", color: "red" }, `    ${error}`));
  if (res) {
    const count = Object.keys(res.detected).length;
    lines.push(h(Text, { key: "sum", color: "gray" },
      `    ${count} value(s) found${count ? ` (${kindSummary(res.detected)})` : ""}` +
      `, ${res.regions} region(s) over ${res.pages} page(s)`));
    if (res.dryRun) {
      for (const [val, kind] of Object.entries(res.detected).sort((a, b) =>
        a[1].localeCompare(b[1]))) {
        lines.push(h(Text, { key: `d${val}` }, `      [${kind}] ${val}`));
      }
    } else if (res.leaks.length) {
      lines.push(h(Text, { key: "leak", color: "yellow" },
        `    still in text layer: ${res.leaks.join(", ")} (review ${dst})`));
    } else {
      lines.push(h(Text, { key: "out", color: "gray" }, `    -> ${dst}`));
    }
    if (!count && !res.shared) {
      lines.push(h(Text, { key: "none", color: "yellow" },
        "    nothing detected: scanned/image PDF, or not a supported form?"));
    }
  }
  return h(Box, { flexDirection: "column" }, ...lines);
}

export default function App({ jobs: initial, opts, onDone }) {
  const { exit } = useApp();
  const [jobs, setJobs] = useState(initial.map((j) => ({ ...j, state: "pending" })));
  const [phase, setPhase] = useState("scan");
  const [frame, setFrame] = useState(0);
  const [finished, setFinished] = useState([]); // indexes, completion order

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const update = (i, patch) => {
      setJobs((js) => js.map((j, k) => (k === i ? { ...j, ...patch } : j)));
      if (["ok", "warn", "error"].includes(patch.state)) setFinished((f) => [...f, i]);
    };

    (async () => {
      const bytes = [];
      const shared = {};
      const multi = initial.length > 1 && opts.share;

      // Pass 1: read every file and, in a batch, learn names/addresses from
      // all of them so a lone cover letter still gets the name redacted.
      for (const [i, job] of initial.entries()) {
        update(i, { state: "scanning" });
        await tick();
        try {
          const data = new Uint8Array(readFileSync(job.src));
          if (!new TextDecoder().decode(data.slice(0, 5)).startsWith("%PDF")) {
            throw new Error("not a PDF (missing %PDF header)");
          }
          bytes[i] = data;
          if (multi) Object.assign(shared, detectLearned(mupdf, data));
          update(i, { state: "pending" });
        } catch (err) {
          update(i, { state: "error", error: String(err.message || err) });
        }
      }

      // Pass 2: redact.
      setPhase("redact");
      let failed = 0;
      for (const [i, job] of initial.entries()) {
        if (!bytes[i]) { failed++; continue; }
        update(i, { state: "working" });
        await tick();
        try {
          const res = redactPdf(mupdf, bytes[i], { verify: opts.verify, shared });
          res.dryRun = opts.dryRun;
          res.shared = multi;
          if (!opts.dryRun) {
            mkdirSync(dirname(job.dst), { recursive: true });
            writeFileSync(job.dst, res.bytes);
          }
          if (res.leaks.length) failed++;
          delete res.bytes;
          update(i, { state: res.leaks.length ? "warn" : "ok", res });
        } catch (err) {
          failed++;
          update(i, { state: "error", error: String(err.message || err) });
        }
      }
      setPhase("done");
      onDone(failed ? 1 : 0);
      await tick();
      exit();
    })();
  }, []);

  const done = finished.map((i) => jobs[i]);
  const ok = jobs.filter((j) => j.state === "ok").length;
  const warn = jobs.filter((j) => j.state === "warn").length;
  const err = jobs.filter((j) => j.state === "error").length;
  const active = jobs.filter((j) => ["scanning", "working"].includes(j.state));

  const header = phase === "scan"
    ? `Scanning ${jobs.length} file(s) for names and addresses...`
    : phase === "redact"
      ? `Redacting ${done.length}/${jobs.length}${opts.dryRun ? " (dry run)" : ""}...`
      : null;

  return h(Box, { flexDirection: "column" },
    // Finished files print once and scroll up (Static); only live rows repaint.
    h(Static, { items: opts.quiet ? done.filter((j) => j.state !== "ok") : done },
      (job) => h(FileLine, { key: job.src, job, frame: 0 })),
    ...active.map((job) => h(FileLine, { key: job.src, job, frame })),
    header && h(Text, { color: "cyan" }, header),
    phase === "done" && h(Box, { marginTop: 1, flexDirection: "column" },
      h(Text, { bold: true },
        `${opts.dryRun ? "Checked" : "Redacted"} ${ok + warn} of ${jobs.length} file(s)` +
        (warn ? `, ${warn} with possible leaks` : "") + (err ? `, ${err} failed` : "") + "."),
      !opts.dryRun && ok + warn > 0 && h(Text, { color: "gray" },
        "Redaction is heuristic: open each output and review it before sharing.")));
}
