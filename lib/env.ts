import { z } from 'zod';

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  AUTH_OIDC_ISSUER: z.string().url(),
  AUTH_OIDC_CLIENT_ID: z.string().min(1),
  AUTH_OIDC_CLIENT_SECRET: z.string().min(1),
  MEILI_HOST: z.string().url(),
  MEILI_KEY: z.string().min(1),
  FILES_DIR: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().min(1),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().min(1),
  WEB_PUSH_CONTACT_EMAIL: z
    .string()
    .startsWith('mailto:')
    .refine(
      (val) => z.string().email().safeParse(val.slice(7)).success,
      'Invalid email after mailto:',
    ),
  FORWARDEMAIL_API_KEY: z.string().min(1),
  FORWARDEMAIL_FROM_ADDRESS: z.string().min(1),
  // Inbound webhook auth (paired with the ForwardEmail "inbox:" alias).
  //   - INBOUND_EMAIL_TOKEN sits in the DNS TXT URL path. DNS TXT is public,
  //     so this is not a secret on its own; HMAC carries the real defense.
  //     16+ char minimum so a typo or truncation fails fast.
  //   - INBOUND_EMAIL_HMAC_KEY must match ForwardEmail's "Webhook Signature
  //     Payload Verification Key" exactly. The actual secret; never traverses
  //     the wire once configured.
  INBOUND_EMAIL_TOKEN: z.string().min(16),
  INBOUND_EMAIL_HMAC_KEY: z.string().min(16),
  APP_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),
  // Empty string is tolerated alongside undefined: the Dockerfile's
  // `ARG SENTRY_DSN` + `ENV SENTRY_DSN=$SENTRY_DSN` pattern produces an
  // empty-string ENV when no --build-arg is passed, which a bare
  // `.url().optional()` would reject. Consumer code already truthy-checks
  // (`if (process.env.SENTRY_DSN)`), so empty string degrades cleanly.
  SENTRY_DSN: z.string().url().or(z.literal('')).optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().or(z.literal('')).optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(input: Record<string, string | undefined>): Env {
  return EnvSchema.parse(input);
}

// Lazy singleton — only validates process.env on first access.
let _env: Env | undefined;
export function getEnv(): Env {
  if (!_env) _env = parseEnv(process.env);
  return _env;
}
