import { describe, expect, it, vi } from 'vitest';
import { applyActionFieldErrors } from './helpers';

// `setError` is the only thing the helper touches, so a spy is the whole
// harness — no form, no DOM, no RHF instance needed.
function spy() {
  return vi.fn();
}

describe('applyActionFieldErrors', () => {
  it('returns false and calls nothing when there are no fieldErrors', () => {
    const setError = spy();
    // biome-ignore lint/suspicious/noExplicitAny: spy stands in for UseFormSetError
    expect(applyActionFieldErrors(setError as any, { ok: false })).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it('sets a flat key on its own field and reports applied', () => {
    const setError = spy();
    const applied = applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { name: ['Required'] },
    });

    expect(applied).toBe(true);
    expect(setError).toHaveBeenCalledWith('name', { type: 'server', message: 'Required' });
    expect(setError).toHaveBeenCalledTimes(1);
  });

  // The regression from #304: a dotted key alone used to return applied=true
  // while rendering nothing, which suppressed the caller's fallback toast.
  it('mirrors a dotted key to root and still reports applied', () => {
    const setError = spy();
    const applied = applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { 'metadata.dims': ['Invalid input'] },
    });

    expect(applied).toBe(true);
    expect(setError).toHaveBeenCalledWith('metadata.dims', {
      type: 'server',
      message: 'Invalid input',
    });
    expect(setError).toHaveBeenCalledWith('root', {
      type: 'server',
      message: 'Invalid input',
    });
  });

  it('sets a flat key on its field and a dotted key on both its path and root', () => {
    const setError = spy();
    applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { name: ['Required'], 'metadata.dims': ['Invalid input'] },
    });

    expect(setError).toHaveBeenCalledWith('name', { type: 'server', message: 'Required' });
    expect(setError).toHaveBeenCalledWith('metadata.dims', {
      type: 'server',
      message: 'Invalid input',
    });
    expect(setError).toHaveBeenCalledWith('root', {
      type: 'server',
      message: 'Invalid input',
    });
  });

  it('joins several dotted messages into one root message', () => {
    const setError = spy();
    applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { 'metadata.a': ['First'], 'metadata.b': ['Second'] },
    });

    expect(setError).toHaveBeenCalledWith('root', {
      type: 'server',
      message: 'First; Second',
    });
  });

  // The caller sets root from result.formError immediately after calling us,
  // which would overwrite anything we put there.
  it('leaves root to the caller when formError is present, and returns false', () => {
    const setError = spy();
    const applied = applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { 'metadata.dims': ['Invalid input'] },
      formError: 'Something went wrong',
    });

    expect(setError).toHaveBeenCalledWith('metadata.dims', {
      type: 'server',
      message: 'Invalid input',
    });
    expect(setError).not.toHaveBeenCalledWith('root', expect.anything());
    // Asserting the RETURN VALUE, not just the calls: this is the one branch
    // where `applied` is indirect — the user sees the caller's formError
    // banner, not anything this helper rendered.
    expect(applied).toBe(false);
  });

  it('skips a key whose messages array is empty', () => {
    const setError = spy();
    const applied = applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { name: [] },
    });

    expect(applied).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it('uses only the first message when a key has several', () => {
    const setError = spy();
    applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { name: ['First', 'Second'] },
    });

    expect(setError).toHaveBeenCalledWith('name', { type: 'server', message: 'First' });
    expect(setError).toHaveBeenCalledTimes(1);
  });
});
