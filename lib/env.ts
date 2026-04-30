import { z } from 'zod';

const EnvSchema = z.object({
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
