import '@testing-library/jest-dom/vitest';

// lib/logger.ts reads LOG_LEVEL once, at import. An exported LOG_LEVEL=fatal
// silenced logger.error and failed the Sentry-bridge tests locally while CI,
// which never sets it for Vitest, stayed green. Setup files run before each
// test file's imports, so dropping it here gives every run CI's default.
delete process.env.LOG_LEVEL;
