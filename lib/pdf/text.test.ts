// Two layers, tested separately:
//
//  - decodePdfText (text-thread.mjs) is the page loop. It must bound the
//    DECODE, not just the returned string. The regression was a small inbound
//    PDF declaring many textless pages: the old implementation (unpdf's
//    extractText) decoded every page before slicing to maxChars, and maxChars
//    never triggered because there was no text. These tests run it in-process
//    with unpdf wrapped, and count getPage calls (the work) rather than time.
//  - extractPdfText (text.ts) runs that loop in a worker thread under a
//    wall-clock deadline. One hostile page can burn CPU inside a single
//    getTextContent, which no page or char cap reaches, and in-thread timers
//    cannot fire during it. These tests use the real thread and the real unpdf
//    (module mocks do not cross into a worker thread).
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createDeflate } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pagesDecoded: number[] = [];
// Per-page text items to serve instead of pdf.js's, for exact whitespace.
let fakeItems: Array<Array<{ str: string; hasEOL: boolean }>> | null = null;
const load = vi.hoisted(() => ({ destroyed: 0 }));

vi.mock('unpdf', async (importOriginal) => {
  const real = await importOriginal<typeof import('unpdf')>();
  return {
    ...real,
    getDocumentProxy: async (...args: Parameters<typeof real.getDocumentProxy>) => {
      const pdf = await real.getDocumentProxy(...args);
      const destroy = pdf.loadingTask.destroy.bind(pdf.loadingTask);
      pdf.loadingTask.destroy = () => {
        load.destroyed++;
        return destroy();
      };
      const getPage = pdf.getPage.bind(pdf);
      pdf.getPage = (n: number) => {
        pagesDecoded.push(n);
        const items = fakeItems?.[n - 1];
        if (items) {
          return Promise.resolve({
            getTextContent: async () => ({ items }),
            cleanup: () => true,
          }) as unknown as ReturnType<typeof getPage>;
        }
        return getPage(n);
      };
      return pdf;
    },
  };
});

import { extractPdfText, PdfMemoryError, PdfTimeoutError } from './text';
// @ts-expect-error -- untyped .mjs (Node runs it directly in a thread; allowJs is off)
import { DEFAULT_MAX_PAGES, decodePdfText } from './text-thread.mjs';

function decode(
  buf: Buffer,
  opts: { maxChars?: number; maxPages?: number } = {},
): Promise<{ text: string; pageCount: number }> {
  return decodePdfText(new Uint8Array(buf), opts);
}

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

/**
 * One page that draws Form XObject X0 `fan` times; X0 draws X1 `fan` times,
 * and so on `depth` levels down to a leaf holding one text run. That is
 * fan^depth text runs from about 2 KB. depth 3, fan 40 already costs ~2s
 * of CPU inside ONE getTextContent; each level multiplies that by `fan`.
 */
function makeXObjectBomb(depth: number, fan: number): Buffer {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [4 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const draws = Array(fan).fill('/X Do').join('\n');
  for (let d = 0; d < depth; d++) {
    const id = 6 + d;
    const leaf = d === depth - 1;
    const body = leaf ? 'BT /F1 1 Tf (a) Tj ET' : draws;
    const res = leaf ? '/Font << /F1 3 0 R >>' : `/XObject << /X ${id + 1} 0 R >>`;
    objs[id] =
      `<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << ${res} >> ` +
      `/Length ${body.length} >>\nstream\n${body}\nendstream`;
  }
  objs[4] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
    '/Resources << /XObject << /X 6 0 R >> >> /Contents 5 0 R >>';
  objs[5] = `<< /Length ${draws.length} >>\nstream\n${draws}\nendstream`;
  return serialize(objs);
}

function serialize(objs: string[]): Buffer {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

beforeEach(() => {
  pagesDecoded.length = 0;
  load.destroyed = 0;
});

describe('decodePdfText', () => {
  it("matches unpdf's own merged-text output for a small document", async () => {
    const buf = readFileSync(join(process.cwd(), 'tests/fixtures/sample.pdf'));
    const { extractText } = await vi.importActual<typeof import('unpdf')>('unpdf');
    const expected = await extractText(new Uint8Array(buf), { mergePages: true });
    const got = await decode(buf);
    expect(got.text).toBe(expected.text);
    expect(got.pageCount).toBe(expected.totalPages);
  });

  it('decodes at most maxPages pages of a many-page textless PDF', async () => {
    const buf = makePdf(Array.from({ length: 1000 }, () => null));
    const got = await decode(buf, { maxChars: 5000, maxPages: 5 });
    expect(pagesDecoded).toEqual([1, 2, 3, 4, 5]);
    expect(got.pageCount).toBe(1000);
    expect(got.text.trim()).toBe(''); // page joins survive, as in unpdf
  });

  it('applies DEFAULT_MAX_PAGES when the caller passes no cap', async () => {
    const buf = makePdf(Array.from({ length: DEFAULT_MAX_PAGES + 20 }, () => null));
    await decode(buf);
    expect(pagesDecoded).toHaveLength(DEFAULT_MAX_PAGES);
  });

  it('stops decoding once maxChars is reached', async () => {
    const buf = makePdf(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd']);
    const got = await decode(buf, { maxChars: 15 });
    expect(pagesDecoded).toEqual([1, 2]);
    expect(got.text).toBe('aaaaaaaaaa\nbbbb');
  });

  it('returns every page in order when under both caps', async () => {
    const got = await decode(makePdf(['first', 'second', 'third']));
    expect(got.text).toBe('first\nsecond\nthird');
    expect(pagesDecoded).toEqual([1, 2, 3]);
  });
});

describe('decodePdfText — parity under maxChars', () => {
  // Early stop must never change the result: for any budget, the output is
  // the full merged extraction cut to that budget, as unpdf would give it.
  it.each([1, 7, 40, 120, 500, 2000, 10_000])('maxChars=%i matches unpdf sliced', async (k) => {
    const { extractText } = await vi.importActual<typeof import('unpdf')>('unpdf');
    const buf = readFileSync(join(__dirname, '..', '..', 'tests', 'fixtures', 'sample.pdf'));
    const full = await extractText(new Uint8Array(buf), { mergePages: true });
    const ours = await decode(buf, { maxChars: k });
    expect(ours.text).toBe(String(full.text).slice(0, k));
  });

  it('a page whose text shrinks when normalized does not end the budget early', async () => {
    // Page 1 is 10 raw chars, but its run of blank lines collapses to one, so
    // it normalizes to 8. Stopping on the raw count returned 8 chars where
    // the full extraction fills all 10 from page 2.
    fakeItems = [
      [
        { str: 'aaaa', hasEOL: true },
        { str: '', hasEOL: true },
        { str: '', hasEOL: true },
        { str: '', hasEOL: true },
        { str: 'bb', hasEOL: false },
      ],
      [{ str: 'cccccccc', hasEOL: false }],
    ];
    try {
      pagesDecoded.length = 0;
      const ours = await decode(makePdf(['x', 'y']), { maxChars: 10 });
      expect(ours.text).toBe('aaaa\n\nbb\nc');
      expect(pagesDecoded).toEqual([1, 2]);
    } finally {
      fakeItems = null;
    }
  });
});

describe('decodePdfText — NUL', () => {
  // Postgres `text` rejects 0x00, and a real email PDF's text layer carried
  // one. Stripped here, before the budget is counted, so NULs neither reach a
  // caller nor spend maxChars (or the job's OCR threshold) on nothing.
  it('drops NULs and does not count them against maxChars', async () => {
    fakeItems = [
      [{ str: 'ab\u0000\u0000\u0000\u0000\u0000\u0000cd', hasEOL: false }],
      [{ str: 'efgh', hasEOL: false }],
    ];
    try {
      pagesDecoded.length = 0;
      const ours = await decode(makePdf(['x', 'y']), { maxChars: 8 });
      expect(ours.text).toBe('abcd\nefg');
      expect(ours.text).not.toContain('\u0000');
      expect(pagesDecoded).toEqual([1, 2]);
    } finally {
      fakeItems = null;
    }
  });
});

describe('decodePdfText — document lifecycle', () => {
  it('destroys the loading task after a successful decode', async () => {
    await decode(makePdf(['x']));
    expect(load.destroyed).toBe(1);
  });
});

/**
 * One page whose content stream is `mb` MiB of spaces, Flate-compressed to
 * about a thousandth of that. pdf.js inflates it into typed arrays, which live
 * OUTSIDE the V8 heap: a thread heap cap never sees them.
 */
async function makeFlateBomb(mb: number): Promise<Buffer> {
  const z = createDeflate({ level: 9 });
  const parts: Buffer[] = [];
  z.on('data', (c: Buffer) => parts.push(c));
  const chunk = Buffer.alloc(1 << 20, 0x20);
  for (let i = 0; i < mb; i++) if (!z.write(chunk)) await once(z, 'drain');
  z.end();
  await once(z, 'end');
  const stream = Buffer.concat(parts);

  const pieces: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Buffer | string) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    pieces.push(buf);
    length += buf.length;
  };
  push('%PDF-1.4\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
  ];
  objs.forEach((body, i) => {
    offsets[i + 1] = length;
    push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  offsets[4] = length;
  push(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`);
  push(stream);
  push('\nendstream\nendobj\n');
  const xrefAt = length;
  push('xref\n0 5\n0000000000 65535 f \n');
  for (let id = 1; id <= 4; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(pieces);
}

describe('extractPdfText — wall-clock deadline (real worker thread, real unpdf)', () => {
  it('returns the same text as the in-process decode', async () => {
    const buf = readFileSync(join(process.cwd(), 'tests/fixtures/sample.pdf'));
    const { extractText } = await vi.importActual<typeof import('unpdf')>('unpdf');
    const expected = await extractText(new Uint8Array(buf), { mergePages: true });
    const got = await extractPdfText(buf, { maxChars: 120, maxPages: 2 });
    expect(got.text).toBe(String(expected.text).slice(0, 120));
    expect(got.pageCount).toBe(expected.totalPages);
  });

  it('a hostile page that outlives the deadline is cut off and rejects', async () => {
    // ~30s of CPU in one getTextContent if left alone.
    const bomb = makeXObjectBomb(4, 30);
    const started = Date.now();
    await expect(extractPdfText(bomb, { timeoutMs: 500 })).rejects.toBeInstanceOf(PdfTimeoutError);
    // The deadline itself, not the parse finishing: well under the parse time.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it('a malformed PDF rejects rather than resolving empty', async () => {
    await expect(extractPdfText(Buffer.from('%PDF-1.4\nnot really a pdf'))).rejects.toThrow();
  });

  it("a malformed PDF keeps pdf.js's exception name across the thread", async () => {
    // Sentry groups by it; a generic Error would merge every PDF failure.
    await expect(extractPdfText(Buffer.from('%PDF-1.4\nnot really a pdf'))).rejects.toMatchObject({
      name: 'InvalidPDFException',
      message: 'Invalid PDF structure.',
    });
  });

  it('terminates the thread on every outcome (it owns any undestroyed loading task)', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    try {
      await extractPdfText(makePdf(['ok']));
      await extractPdfText(Buffer.from('%PDF-1.4\nnot really a pdf')).catch(() => {});
      expect(terminate).toHaveBeenCalledTimes(2);
    } finally {
      terminate.mockRestore();
    }
  });
});

describe('extractPdfText — memory budget (real worker thread, real unpdf)', () => {
  it('a decompression bomb is cut off by RSS growth, not left to grow the process', async () => {
    // ~200 KB on disk, 400 MiB once inflated; without a budget it resolves
    // after growing the process by more than the inflated size.
    const bomb = await makeFlateBomb(400);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024); // inside the inbound cap
    await expect(
      extractPdfText(bomb, { timeoutMs: 30_000, maxMemoryGrowthMb: 64 }),
    ).rejects.toBeInstanceOf(PdfMemoryError);
  }, 60_000);
});
