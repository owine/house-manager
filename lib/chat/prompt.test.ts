import { describe, expect, it } from 'vitest';
import { buildSnapshotBlock, CHAT_SYSTEM_PROMPT } from './prompt';

describe('CHAT_SYSTEM_PROMPT', () => {
  it('forbids inventing IDs', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/never.*(invent|make up)/i);
  });

  it('requires YYYY-MM-DD dates', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('YYYY-MM-DD');
  });

  it('instructs short topic-scoped notes', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/##/);
  });
});

describe('buildSnapshotBlock', () => {
  it('includes the anchor date and every referenceable id', () => {
    const block = buildSnapshotBlock({
      anchorDay: '2026-07-03',
      items: [
        { id: 'item-1', name: 'Water Heater', categoryName: 'Plumbing', location: 'Basement' },
      ],
      systems: [{ id: 'sys-1', name: 'HVAC', location: null }],
      categories: [{ id: 'cat-1', name: 'Lighting' }],
      notes: [{ id: 'note-1', title: 'Lightbulbs' }],
    });

    expect(block).toContain('2026-07-03');
    expect(block).toContain('item-1');
    expect(block).toContain('sys-1');
    expect(block).toContain('cat-1');
    expect(block).toContain('note-1');
  });
});
