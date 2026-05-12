// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { askQuestionInputSchema } from '@/lib/ai/schemas';

describe('askQuestionInputSchema', () => {
  it('accepts a single-turn user message', () => {
    const r = askQuestionInputSchema.safeParse({
      messages: [{ role: 'user', content: 'When did I service the HVAC?' }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts a multi-turn thread ending in a user follow-up', () => {
    const r = askQuestionInputSchema.safeParse({
      messages: [
        { role: 'user', content: 'When did I service the HVAC?' },
        { role: 'assistant', content: 'It was serviced on 2026-01-16.' },
        { role: 'user', content: 'What about the dishwasher?' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects threads where the last message is from the assistant', () => {
    const r = askQuestionInputSchema.safeParse({
      messages: [
        { role: 'user', content: 'When did I service the HVAC?' },
        { role: 'assistant', content: 'It was 2026-01-16.' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects when the latest user message is too short', () => {
    const r = askQuestionInputSchema.safeParse({
      messages: [{ role: 'user', content: '  hi  ' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects when the latest user message is too long', () => {
    const r = askQuestionInputSchema.safeParse({
      messages: [{ role: 'user', content: 'q'.repeat(501) }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty thread', () => {
    expect(askQuestionInputSchema.safeParse({ messages: [] }).success).toBe(false);
  });

  it('rejects threads over 20 turns', () => {
    const messages = Array.from({ length: 21 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `turn ${i}`,
    }));
    // ensure last is user
    messages[messages.length - 1] = { role: 'user', content: 'final question' };
    expect(askQuestionInputSchema.safeParse({ messages }).success).toBe(false);
  });

  it('accepts optional entityTypes filter with valid values', () => {
    const r = askQuestionInputSchema.safeParse({
      messages: [{ role: 'user', content: 'cost?' }],
      entityTypes: ['SERVICE_RECORD', 'WARRANTY'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown entityType values', () => {
    const r = askQuestionInputSchema.safeParse({
      messages: [{ role: 'user', content: 'cost?' }],
      entityTypes: ['SOMETHING_ELSE'],
    });
    expect(r.success).toBe(false);
  });
});
