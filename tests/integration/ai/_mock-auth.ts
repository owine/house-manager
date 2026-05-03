// Shared auth-mock helpers for AI integration tests.
//
// Each test file still has to declare its own `vi.mock('@/lib/auth', ...)` —
// vi.mock is hoisted per-file by design and CANNOT live in a shared module
// (that path was tried in Plan 4b Task 8 and broke under Vitest 4's vmForks
// pool). What CAN be shared is the mutable state + setter: the per-file
// vi.mock factory dynamically imports `currentUserId` from here at call
// time, which is fine because the import resolves AFTER hoisting.
//
// Usage in a test file:
//   import { signInAs } from './_mock-auth';
//   vi.mock('@/lib/auth', async () => {
//     const { currentUserId } = await import('./_mock-auth');
//     return {
//       auth: vi.fn(async () => {
//         const id = currentUserId();
//         return id ? { user: { id } } : null;
//       }),
//     };
//   });
//   // then in tests:  signInAs(user.id) / signInAs(null)

let _currentUserId: string | null = null;

export function signInAs(id: string | null): void {
  _currentUserId = id;
}

export function currentUserId(): string | null {
  return _currentUserId;
}
