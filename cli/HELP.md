redacttax — remove PII from tax PDFs (true redaction, runs locally)

USAGE
  redacttax [options] <file.pdf | folder> [more files or folders...]

  Each input PDF is written next to its source as <name>_redacted.pdf
  (or under --out-dir). Nothing is uploaded anywhere.

EXAMPLES
  redacttax return.pdf                  one file  -> return_redacted.pdf
  redacttax k1.pdf letter.pdf 1040.pdf  several files in one batch
  redacttax TaxFiles/                   every PDF directly inside TaxFiles/
  redacttax TaxFiles/ -r                ...and in all of its subfolders
  redacttax TaxFiles/ -r -o Clean/      write outputs to Clean/, keeping the
                                        folder structure
  redacttax TaxFiles/ -r --dry-run      list what would be redacted; write nothing

OPTIONS
  -r, --recursive      descend into subfolders of any folder input
  -o, --out-dir DIR    write outputs into DIR instead of next to each source
      --suffix TEXT    output name suffix (default: _redacted); files already
                       ending in it are skipped when scanning folders
  -n, --dry-run        report detected values per file, write nothing
      --no-share       don't reuse names/addresses found in one file of the
                       batch when redacting the others
      --no-verify      skip the post-redaction leak check
  -q, --quiet          only show files with problems, plus the summary
  -h, --help           show this help
  -v, --version        show the version

WHAT GETS REDACTED
  Every page:        SSN/ITIN, EIN, phone, email, 9-17 digit account numbers
  Form 1040 header:  taxpayer and spouse names, street, city, ZIP
  Schedule K-1:      partner / shareholder / beneficiary name, street, city, ZIP
  Cover letters:     "Name / street / City, ST ZIP" address blocks
  Then everywhere:   each name found is also removed word by word (so a first
                     name on its own, e.g. "Dear Jane", is caught), along with
                     the street, city and ZIP.

  Business names (e.g. the partnership on a K-1) and dollar amounts are kept,
  so the document is still useful for review.

BATCHES SHARE WHAT THEY LEARN
  When you pass several files, names and addresses found in any of them are
  redacted in all of them. A cover letter or statement that has no labeled
  form fields is still cleaned if the K-1 or 1040 is in the same batch.
  Use --no-share to process each file on its own.

EXIT STATUS
  0  every file redacted and verified
  1  a file failed, an input was missing, or detected text survived
  2  bad command-line usage

CAVEATS
  Redaction is heuristic: always open the output and review it before sharing.
  Scanned (image-only) PDFs have no text layer, so nothing can be detected;
  those files are flagged with "nothing detected".
