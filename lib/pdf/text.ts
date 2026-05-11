// Shared PDF text-extraction helper. Wraps `unpdf` so callers don't have
// to know about the dynamic import dance — both the classifier (small
// caps, regex-targeted) and the Ask attachment indexer (larger caps,
// full-document) consume this.
//
// `unpdf` is dynamically imported because the wasm + parser is ~1 MB
// and we don't want it loaded into Server Action paths that never
// touch PDFs.

export type ExtractPdfTextOptions = {
  /** Hard cap on returned text length. Default: no cap (full document). */
  maxChars?: number;
};

export type ExtractPdfTextResult = {
  text: string;
  /** Approximate page count, when unpdf reports it. */
  pageCount?: number;
};

export async function extractPdfText(
  buf: Buffer,
  opts: ExtractPdfTextOptions = {},
): Promise<ExtractPdfTextResult> {
  const { extractText } = await import('unpdf');
  const { text, totalPages } = await extractText(new Uint8Array(buf), { mergePages: true });
  const joined = Array.isArray(text) ? text.join('\n') : (text ?? '');
  const finalText = opts.maxChars ? joined.slice(0, opts.maxChars) : joined;
  return { text: finalText, pageCount: totalPages };
}
