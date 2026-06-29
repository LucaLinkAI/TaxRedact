# Tax PDF Redactor — web app (client-side, Cloudflare Pages)

A browser version of RedactTaxCLI. The redaction engine
([`src/redact.js`](src/redact.js)) is a faithful port of the Python CLI's logic
to [mupdf.js](https://github.com/ArtifexSoftware/mupdf.js) — the **same MuPDF
engine**, compiled to WebAssembly.

**Everything runs in the browser.** The PDF is read, redacted, and downloaded
entirely on the user's device — it is never uploaded to any server. That makes
this safe to host as a plain static site and ideal for non-technical users
handling sensitive tax documents.

## What it does

Identical detection to the CLI:

- Regex PII on every page: SSN/ITIN, EIN, email, phone, account/routing numbers
  (IRS hotlines and blank-EIN placeholders are whitelisted)
- 1040 header fields by layout: taxpayer & spouse names, street, city, ZIP —
  chased across every page
- Redactions are **physically applied** (`applyRedactions`), then the output is
  re-opened and searched to verify no detected PII remains in the text layer

## Develop locally

```bash
cd web
npm install
npm run dev          # http://localhost:5173 — open it and try a PDF
```

Verify the engine against sample PDFs in Node (no browser needed):

```bash
npm run test:node test/pii.pdf test/form1040.pdf
```

Build the production bundle:

```bash
npm run build        # outputs static files to dist/
npm run preview      # serve the built dist/ locally to sanity-check
```

## Deploy to Cloudflare Pages

### Option 1 — Git integration (recommended)

Push this repo to GitHub/GitLab, then in the Cloudflare dashboard:
**Workers & Pages → Create → Pages → Connect to Git**, and set:

| Setting | Value |
| --- | --- |
| **Root directory** | `web` |
| **Framework preset** | Vite (or None) |
| **Build command** | `npm run build` |
| **Build output directory** | `dist` |

If the build needs a newer Node, add an environment variable
`NODE_VERSION = 20` (Settings → Environment variables). Every push to the
production branch then redeploys automatically.

### Option 2 — Direct upload with Wrangler (no Git)

```bash
cd web
npm install
npm run build
npx wrangler pages deploy dist --project-name tax-pdf-redactor
```

Wrangler will prompt you to log in to Cloudflare on first run.

## Notes

- **First load downloads ~10 MB of WebAssembly** (the MuPDF engine). Cloudflare's
  CDN serves and caches it; subsequent visits are instant.
- No special headers (COOP/COEP) are required — this build doesn't use
  SharedArrayBuffer threads.
- ⚠️ Redaction is heuristic. Always review the output before sharing, especially
  for non-standard or scanned (image-based) PDFs, where text can't be searched.
