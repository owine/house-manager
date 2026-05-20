import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { renderPdfPagesToPng } from './render';

function isPng(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

describe('renderPdfPagesToPng', () => {
  it('rasterizes a 1-page PDF to a PNG buffer', async () => {
    const pdf = await readFile('tests/fixtures/sample.pdf');
    const pages = await renderPdfPagesToPng(pdf);
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(isPng(pages[0] as Buffer)).toBe(true);
  });

  it('respects the maxPages cap', async () => {
    const pdf = await readFile('tests/fixtures/sample.pdf');
    const pages = await renderPdfPagesToPng(pdf, { maxPages: 1 });
    expect(pages.length).toBeLessThanOrEqual(1);
  });

  it('returns [] for non-PDF bytes (graceful)', async () => {
    const pages = await renderPdfPagesToPng(Buffer.from('not a pdf'));
    expect(pages).toEqual([]);
  });
});
