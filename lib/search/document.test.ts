import { describe, expect, it } from 'vitest';
import {
  type AttachmentRow,
  type ItemRow,
  type PartRow,
  type ReminderRow,
  toDocument,
} from './document';

const NOW = new Date('2026-05-01T12:00:00Z');

describe('toDocument', () => {
  describe('item', () => {
    it('builds an item document with categorySlug', () => {
      const row: ItemRow = {
        id: 'i1',
        name: 'Furnace',
        manufacturer: 'Lennox',
        model: 'XC25',
        notes: null,
        category: { slug: 'hvac' },
        updatedAt: NOW,
      };
      const doc = toDocument('item', row);
      expect(doc.id).toBe('item-i1');
      expect(doc.kind).toBe('item');
      expect(doc.recordId).toBe('i1');
      expect(doc.title).toBe('Furnace');
      expect(doc.body).toContain('Lennox');
      expect(doc.body).toContain('XC25');
      expect(doc.itemName).toBe('Furnace');
      expect(doc.itemId).toBe('i1');
      expect(doc.categorySlug).toBe('hvac');
      expect(doc.href).toBe('/items/i1');
      expect(doc.iconHint).toBe('📦');
    });
  });

  describe('reminder', () => {
    it('builds a reminder doc with itemName when attached', () => {
      const row: ReminderRow = {
        id: 'r1',
        title: 'Replace HVAC filter',
        description: 'use MERV 13',
        item: { id: 'i1', name: 'Furnace' },
        updatedAt: NOW,
      };
      const doc = toDocument('reminder', row);
      expect(doc.id).toBe('reminder-r1');
      expect(doc.title).toBe('Replace HVAC filter');
      expect(doc.body).toBe('use MERV 13');
      expect(doc.itemName).toBe('Furnace');
      expect(doc.itemId).toBe('i1');
      expect(doc.href).toBe('/reminders/r1');
    });

    it('omits itemName when reminder has no item', () => {
      const row: ReminderRow = {
        id: 'r2',
        title: 'Buy salt',
        description: null,
        item: null,
        updatedAt: NOW,
      };
      const doc = toDocument('reminder', row);
      expect(doc.itemName).toBe('');
      expect(doc.itemId).toBeNull();
      expect(doc.body).toBe('');
    });
  });

  describe('attachment', () => {
    it('builds an attachment doc with filename + dormant extractedText', () => {
      const row: AttachmentRow = {
        id: 'a1',
        filename: 'manual.pdf',
        displayLabel: null,
        extractedText: null, // dormant until Plan 4c
        item: { id: 'i1', name: 'Furnace' },
        createdAt: NOW, // Attachment has createdAt only — no updatedAt column
      };
      const doc = toDocument('attachment', row);
      expect(doc.title).toBe('manual.pdf');
      expect(doc.body).toBe(''); // null extractedText → empty
      expect(doc.itemName).toBe('Furnace');
      expect(doc.iconHint).toBe('📎');
    });

    it('falls back to displayLabel when filename is null (external links)', () => {
      const row: AttachmentRow = {
        id: 'a3',
        filename: null,
        displayLabel: 'Vendor portal',
        extractedText: null,
        item: { id: 'i1', name: 'Furnace' },
        createdAt: NOW,
      };
      const doc = toDocument('attachment', row);
      expect(doc.title).toBe('Vendor portal');
    });

    it('falls back to empty string when both filename and displayLabel are null', () => {
      const doc = toDocument('attachment', {
        id: 'a4',
        filename: null,
        displayLabel: null,
        extractedText: null,
        item: null,
        createdAt: NOW,
      });
      expect(doc.title).toBe('');
    });

    it('uses extractedText in body when populated (Plan 4c hook)', () => {
      const row: AttachmentRow = {
        id: 'a2',
        filename: 'receipt.pdf',
        displayLabel: null,
        extractedText: 'Total: $42.00',
        item: null,
        createdAt: NOW,
      };
      const doc = toDocument('attachment', row);
      expect(doc.body).toBe('Total: $42.00');
    });
  });

  describe('vendor / note / service', () => {
    it('vendor: title is name, no item linkage', () => {
      const doc = toDocument('vendor', {
        id: 'v1',
        name: 'ACME HVAC',
        notes: null,
        updatedAt: NOW,
      });
      expect(doc.title).toBe('ACME HVAC');
      expect(doc.itemId).toBeNull();
      expect(doc.iconHint).toBe('🏢');
    });

    it('note: tags carry through, body is the markdown', () => {
      const doc = toDocument('note', {
        id: 'n1',
        title: 'How to replace',
        body: '...steps...',
        tags: ['hvac', 'maintenance'],
        item: null,
        updatedAt: NOW,
      });
      expect(doc.title).toBe('How to replace');
      expect(doc.body).toBe('...steps...');
      expect(doc.tags).toEqual(['hvac', 'maintenance']);
    });

    it('service: title is summary, body is notes, links to item', () => {
      const doc = toDocument('service', {
        id: 's1',
        summary: 'Annual tune-up',
        notes: 'replaced filter, cleaned coils',
        item: { id: 'i1', name: 'Furnace' },
        updatedAt: NOW,
      });
      expect(doc.title).toBe('Annual tune-up');
      expect(doc.body).toBe('replaced filter, cleaned coils');
      expect(doc.itemName).toBe('Furnace');
      expect(doc.iconHint).toBe('🔧');
    });

    it('service: aggregates every target name into itemName when targetNames is provided', () => {
      const doc = toDocument('service', {
        id: 's2',
        summary: 'Multi-target service',
        notes: null,
        item: { id: 'i1', name: 'Heat Pump' },
        targetNames: ['Heat Pump', 'HVAC System'],
        updatedAt: NOW,
      });
      expect(doc.itemName).toContain('Heat Pump');
      expect(doc.itemName).toContain('HVAC System');
      expect(doc.itemId).toBe('i1');
    });

    it('service: empty targetNames falls back to item name', () => {
      const doc = toDocument('service', {
        id: 's3',
        summary: 'System-only',
        notes: null,
        item: null,
        targetNames: ['HVAC'],
        updatedAt: NOW,
      });
      expect(doc.itemName).toBe('HVAC');
      expect(doc.itemId).toBeNull();
    });
  });

  describe('part', () => {
    const bulb: PartRow = {
      id: 'p1',
      name: 'Backyard bulbs',
      kind: 'BULB',
      manufacturer: 'Feit',
      model: 'ST19-LED-DIM',
      sku: 'FEI-ST19-24',
      location: 'garage shelf',
      notes: 'buy the 24-pack',
      metadata: {
        base: 'E26',
        shape: 'S14',
        colorTempK: 2200,
        dimmable: true,
        // Written by conversational capture — must never be indexed.
        _provenance: { base: 'inferred' },
      },
      item: { id: 'i1', name: 'Backyard string lights' },
      parentNames: ['Backyard string lights', 'Landscape lighting'],
      updatedAt: NOW,
    };

    it('indexes the spec VALUES, not just the name — the point of the kind', () => {
      const doc = toDocument('part', bulb);
      expect(doc.id).toBe('part-p1');
      expect(doc.kind).toBe('part');
      expect(doc.title).toBe('Backyard bulbs');
      expect(doc.body).toContain('E26');
      expect(doc.body).toContain('S14');
      expect(doc.body).toContain('2200');
      // The key travels with the value so "MERV 11"-shaped queries match.
      expect(doc.body).toContain('colorTempK');
      expect(doc.href).toBe('/parts/p1');
      expect(doc.iconHint).toBe('🔩');
    });

    it('indexes the re-buy identity and the rendered kind label', () => {
      const doc = toDocument('part', bulb);
      expect(doc.body).toContain('Feit');
      expect(doc.body).toContain('ST19-LED-DIM');
      expect(doc.body).toContain('FEI-ST19-24');
      expect(doc.body).toContain('garage shelf');
      expect(doc.body).toContain('buy the 24-pack');
      expect(doc.body).toContain('Bulb');
      expect(doc.body).not.toContain('BULB');
    });

    it('drops reserved metadata keys', () => {
      const doc = toDocument('part', bulb);
      expect(doc.body).not.toContain('_provenance');
      expect(doc.body).not.toContain('inferred');
    });

    it('carries every parent name in itemName and the first item parent as the facet', () => {
      const doc = toDocument('part', bulb);
      expect(doc.itemName).toContain('Backyard string lights');
      expect(doc.itemName).toContain('Landscape lighting');
      expect(doc.itemId).toBe('i1');
    });

    it('handles a standalone part with no parents and an empty spec', () => {
      const doc = toDocument('part', {
        ...bulb,
        id: 'p2',
        metadata: {},
        item: null,
        parentNames: [],
      });
      expect(doc.itemName).toBe('');
      expect(doc.itemId).toBeNull();
      expect(doc.body).toContain('Feit');
    });

    it('tolerates a null / non-object metadata column', () => {
      expect(() => toDocument('part', { ...bulb, metadata: null })).not.toThrow();
      const doc = toDocument('part', { ...bulb, metadata: 'nonsense' });
      expect(doc.body).toContain('Feit');
      expect(doc.body).not.toContain('nonsense');
    });
  });
});
