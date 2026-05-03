The nightly Anthropic smoke test failed.

This usually means one of:
- Anthropic SDK call shape changed (model retired, output_config deprecated, etc.)
- API key invalid or rate-limited
- Schema-validation rejection (Claude returned a shape that no longer matches the Zod schema)

**Action:** investigate within 24 hours. Check the workflow run linked above for stack traces and compare the response shape against `lib/ai/schemas.ts`.
