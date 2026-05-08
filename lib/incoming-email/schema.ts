import { z } from 'zod';

// ForwardEmail uses mailparser.simpleParser to render messages, then POSTs
// the resulting JSON. We validate only the fields we consume; unknown keys
// pass through (.passthrough()) so payload extensions don't break ingest.
//
// Reference: forwardemail.net/faq#do-you-support-webhooks
export const ForwardEmailWebhookSchema = z
  .object({
    messageId: z.string().min(1),
    subject: z.string().default(''),
    from: z.object({
      value: z
        .array(
          z.object({
            address: z.string().email(),
            name: z.string().optional(),
          }),
        )
        .min(1),
    }),
    // mailparser sometimes omits date for malformed messages; ingestion falls
    // back to the wall clock when missing.
    date: z.coerce.date().optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    headers: z.record(z.string(), z.unknown()).optional(),
    headerLines: z.array(z.object({ key: z.string(), line: z.string() })).optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string().nullable().optional(),
          contentType: z.string().optional(),
          size: z.number().int().nonnegative().optional(),
          content: z.object({
            type: z.literal('Buffer'),
            // mailparser emits Buffer-as-array; bytes are 0..255.
            data: z.array(z.number().int().min(0).max(255)),
          }),
          cid: z.string().optional(),
        }),
      )
      .default([]),
    dkim: z.unknown().optional(),
    spf: z.unknown().optional(),
    dmarc: z.unknown().optional(),
    session: z.object({ recipient: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export type ForwardEmailWebhookBody = z.infer<typeof ForwardEmailWebhookSchema>;
