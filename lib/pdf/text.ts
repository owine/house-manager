// Shared PDF text-extraction helper. Wraps `unpdf` so callers don't have
// to know about the dynamic import dance — both the classifier (small
// caps, regex-targeted) and the Ask attachment indexer (larger caps,
// full-document) consume this.
//
// `unpdf` is dynamically imported because the wasm + parser is ~1 MB
// and we don't want it loaded into Server Action paths that never
// touch PDFs.
//
// BOUND THE WORK, NOT JUST THE OUTPUT. unpdf's own `extractText` decodes
// every page concurrently (`Promise.all` over `numPages`) and only then
// returns, so slicing its result to `maxChars` capped the string while the
// parse itself stayed unbounded: a small inbound PDF declaring many pages
// pinned the classify worker, and `maxChars` never triggered because the
// pages carried no text. Pages are therefore decoded one at a time, at most
// `maxPages` of them, stopping as soon as `maxChars` is reached.

export type ExtractPdfTextOptions = {
  /** Hard cap on returned text length. Also stops page iteration early. */
  maxChars?: number;
  /**
   * Hard cap on pages decoded. Untrusted input (inbound email) must pass a
   * small value; the default exists so no caller is ever unbounded.
   */
  maxPages?: number;
};

export type ExtractPdfTextResult = {
  text: string;
  /** Page count the document declares (may exceed the pages decoded). */
  pageCount?: number;
};

/** Generous: member-uploaded manuals for Ask indexing. Not for hostile input. */
export const DEFAULT_MAX_PAGES = 300;

type TextItem = { str?: string; hasEOL?: boolean };

/** Same whitespace normalization as unpdf's `mergePages: true`. */
function normalizeMergedText(texts: string[]): string {
  return texts
    .join('\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

export async function extractPdfText(
  buf: Buffer,
  opts: ExtractPdfTextOptions = {},
): Promise<ExtractPdfTextResult> {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  try {
    const pageCount = pdf.numPages;
    const last = Math.min(pageCount, opts.maxPages ?? DEFAULT_MAX_PAGES);
    const pages: string[] = [];
    let chars = 0;
    for (let n = 1; n <= last; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = (content.items as TextItem[])
        .filter((item) => item.str != null)
        .map((item) => item.str + (item.hasEOL ? '\n' : ''))
        .join('');
      page.cleanup();
      pages.push(text);
      chars += text.length;
      if (opts.maxChars && chars >= opts.maxChars) break;
    }
    const joined = normalizeMergedText(pages);
    return { text: opts.maxChars ? joined.slice(0, opts.maxChars) : joined, pageCount };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
