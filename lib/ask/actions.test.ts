// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { askQuestionInputSchema } from '@/lib/ai/schemas';

describe('askQuestionInputSchema', () => {
  it('accepts a normal question', () => {
    const r = askQuestionInputSchema.safeParse({ question: 'When did I service the HVAC?' });
    expect(r.success).toBe(true);
  });

  it('trims whitespace and rejects too-short questions', () => {
    expect(askQuestionInputSchema.safeParse({ question: '  hi  ' }).success).toBe(false);
  });

  it('rejects questions over 500 chars', () => {
    expect(askQuestionInputSchema.safeParse({ question: 'q'.repeat(501) }).success).toBe(false);
  });

  it('accepts optional entityTypes filter with valid values', () => {
    const r = askQuestionInputSchema.safeParse({
      question: 'cost?',
      entityTypes: ['SERVICE_RECORD', 'WARRANTY'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown entityType values', () => {
    const r = askQuestionInputSchema.safeParse({
      question: 'cost?',
      entityTypes: ['SOMETHING_ELSE'],
    });
    expect(r.success).toBe(false);
  });
});
