// extractPdfText must bound the DECODE, not just the returned string. The
// regression was a small inbound PDF declaring many textless pages: the old
// implementation (unpdf's extractText) decoded every page before slicing to
// maxChars, and maxChars never triggered because there was no text. These
// tests count getPage calls, which is the work, rather than measuring time.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pagesDecoded: number[] = [];

vi.mock('unpdf', async (importOriginal) => {
  const real = await importOriginal<typeof import('unpdf')>();
  return {
    ...real,
    getDocumentProxy: async (...args: Parameters<typeof real.getDocumentProxy>) => {
      const pdf = await real.getDocumentProxy(...args);
      const getPage = pdf.getPage.bind(pdf);
      pdf.getPage = (n: number) => {
        pagesDecoded.push(n);
        return getPage(n);
      };
      return pdf;
    },
  };
});

import { DEFAULT_MAX_PAGES, extractPdfText } from './text';

/** A minimal valid PDF with one page per entry; `null` is a textless page. */
function makePdf(pageTexts: Array<string | null>): Buffer {
  const objs: string[] = [];
  const pageIds: number[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let next = 4;
  for (const text of pageTexts) {
    const pageId = next++;
    const contentId = next++;
    const stream = text === null ? '' : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objs[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objs[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    pageIds.push(pageId);
  }
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < next; id++) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let id = 1; id < next; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

beforeEach(() => {
  pagesDecoded.length = 0;
});

describe('extractPdfText', () => {
  it("matches unpdf's own merged-text output for a small document", async () => {
    const buf = readFileSync(join(process.cwd(), 'tests/fixtures/sample.pdf'));
    const { extractText } = await vi.importActual<typeof import('unpdf')>('unpdf');
    const expected = await extractText(new Uint8Array(buf), { mergePages: true });
    const got = await extractPdfText(buf);
    expect(got.text).toBe(expected.text);
    expect(got.pageCount).toBe(expected.totalPages);
  });

  it('decodes at most maxPages pages of a many-page textless PDF', async () => {
    const buf = makePdf(Array.from({ length: 1000 }, () => null));
    const got = await extractPdfText(buf, { maxChars: 5000, maxPages: 5 });
    expect(pagesDecoded).toEqual([1, 2, 3, 4, 5]);
    expect(got.pageCount).toBe(1000);
    expect(got.text.trim()).toBe(''); // page joins survive, as in unpdf
  });

  it('applies DEFAULT_MAX_PAGES when the caller passes no cap', async () => {
    const buf = makePdf(Array.from({ length: DEFAULT_MAX_PAGES + 20 }, () => null));
    await extractPdfText(buf);
    expect(pagesDecoded).toHaveLength(DEFAULT_MAX_PAGES);
  });

  it('stops decoding once maxChars is reached', async () => {
    const buf = makePdf(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd']);
    const got = await extractPdfText(buf, { maxChars: 15 });
    expect(pagesDecoded).toEqual([1, 2]);
    expect(got.text).toBe('aaaaaaaaaa\nbbbb');
  });

  it('returns every page in order when under both caps', async () => {
    const got = await extractPdfText(makePdf(['first', 'second', 'third']));
    expect(got.text).toBe('first\nsecond\nthird');
    expect(pagesDecoded).toEqual([1, 2, 3]);
  });
});
