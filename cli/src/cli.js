#!/usr/bin/env node
// redacttax — terminal front end (React/Ink) for the tax-PDF PII redactor.
// The engine is the same web/src/redact.js the browser app uses, so detection
// stays in sync with the web app (and, by convention, redacttaxcli.py).
import { existsSync, readFileSync } from "node:fs";
import React from "react";
import { render } from "ink";
import App from "./App.js";
import { collectJobs, parseArgs } from "./files.js";

// HELP.md / package.json sit next to the bundled build (dist/), or one level
// up when running from src/.
const bundled = (name) => {
  const here = new URL(`./${name}`, import.meta.url);
  return existsSync(here) ? here : new URL(`../${name}`, import.meta.url);
};
const pkg = JSON.parse(readFileSync(bundled("package.json")));
const helpText = () => readFileSync(bundled("HELP.md"), "utf8");

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`redacttax: ${err.message}\nRun "redacttax --help" for usage.`);
  process.exit(2);
}

if (opts.help) {
  process.stdout.write(helpText());
  process.exit(0);
}
if (opts.version) {
  console.log(`redacttax ${pkg.version}`);
  process.exit(0);
}
if (!opts.inputs.length) {
  console.error('redacttax: no input PDFs or folders given.\nRun "redacttax --help" for usage.');
  process.exit(2);
}

const { jobs, problems } = collectJobs(opts);
for (const p of problems) console.error(`redacttax: ${p}`);
if (!jobs.length) {
  console.error("redacttax: nothing to process.");
  process.exit(1);
}

let code = problems.length ? 1 : 0;
const app = render(React.createElement(App, {
  jobs, opts, onDone: (c) => { code = Math.max(code, c); },
}));
await app.waitUntilExit();
process.exit(code);
