# CLAUDE.md

Notes for AI agents working in this repo. Keep this file short — only
non-obvious constraints that aren't visible from the code itself.

## Do not collapse the TypeScript 6/7 aliases

`package.json` intentionally installs two TypeScript versions under aliased names:

```jsonc
"@typescript/native": "npm:typescript@7.0.2",       // Go port; provides bin `tsc`
"typescript": "npm:@typescript/typescript6@6.0.2",  // shim providing the TS 6 JS API
```

This looks like a mistake. It is not. **Do not "fix" it to a single
`"typescript": "7.x"` entry.**

TypeScript 7 is the Go rewrite: it ships a compiler but no JavaScript API. Next.js
16 loads `next.config.ts` *through* that API, as do Prisma, `@auth/prisma-adapter`
and shadcn. Collapsing the aliases means `lint`, `typecheck` and even `next build`
still pass, and then the **e2e/a11y jobs fail** with:

> It looks like you're trying to use TypeScript but do not have the required package(s) installed

followed by a 120s Playwright `webServer` timeout. The damage surfaces nowhere near
the change. See PR #281 (the broken bump) and #290 (this arrangement).

If a Renovate PR proposes changing either entry, check it preserves the split.

The aliases can be removed — in favour of a plain `"typescript": "7.x"` — once
Next.js supports TS 7 natively. Nothing else in this repo blocks that; it lints
with Biome, so there is no typescript-eslint dependency to wait on.

Full rationale: [`docs/README.md` § TypeScript toolchain](docs/README.md#typescript-toolchain).
