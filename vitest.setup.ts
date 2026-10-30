import '@testing-library/jest-dom/vitest';
import { UNSET_FOR_TESTS } from './vitest.env';

// Setup files run before each test file's imports, so this lands before any
// module reads these keys at import time. Rationale in vitest.env.ts.
for (const key of UNSET_FOR_TESTS) delete process.env[key];
