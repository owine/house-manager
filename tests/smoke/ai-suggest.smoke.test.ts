import { describe, expect, it } from 'vitest';

const apiKey = process.env.ANTHROPIC_API_KEY;
const skip = !apiKey || apiKey.includes('placeholder');

describe.skipIf(skip)('Anthropic SDK live smoke', () => {
  it('messages.parse responds with the expected shape on Haiku 4.5 (reminders schema)', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
    const { proposeRemindersResponseSchema } = await import('@/lib/ai/schemas');

    const client = new Anthropic({ apiKey });
    const result = await client.messages.parse({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content:
            'Suggest 2 generic household maintenance reminders. Each must include title, recurrence (interval/monthly/yearly), leadTimeDays, and a one-sentence rationale.',
        },
      ],
      output_config: { format: zodOutputFormat(proposeRemindersResponseSchema) },
    } as never);

    const parsed = (result as { parsed_output: { proposals: unknown[] } }).parsed_output;
    expect(parsed.proposals.length).toBeGreaterThanOrEqual(0);
    expect(parsed.proposals.length).toBeLessThanOrEqual(10); // schema cap
  });

  it('messages.parse responds with the expected shape on Haiku 4.5 (checklist schema)', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
    const { proposeChecklistResponseSchema } = await import('@/lib/ai/schemas');

    const client = new Anthropic({ apiKey });
    const result = await client.messages.parse({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content:
            'Generate a 3-item spring household maintenance checklist with a name, optional description, and a rationale per item.',
        },
      ],
      output_config: { format: zodOutputFormat(proposeChecklistResponseSchema) },
    } as never);

    const parsed = (result as { parsed_output: { name: string; items: unknown[] } }).parsed_output;
    expect(parsed.name).toBeTruthy();
    expect(parsed.items.length).toBeGreaterThanOrEqual(1);
    expect(parsed.items.length).toBeLessThanOrEqual(20); // schema cap
  });
});
