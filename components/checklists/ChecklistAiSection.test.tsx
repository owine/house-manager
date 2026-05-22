// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/tests/a11y/axe';

const proposeChecklist = vi.fn();
vi.mock('@/lib/ai/suggest/checklist', () => ({
  proposeChecklist: (...a: unknown[]) => proposeChecklist(...a),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/app/(app)/_components/SuggestionPreview', () => ({
  SuggestionPreview: ({ name }: { name: string }) => <div>{name}</div>,
}));

import { ChecklistAiSection } from './ChecklistAiSection';

afterEach(() => {
  cleanup();
  proposeChecklist.mockReset();
});
const okResult = {
  ok: true,
  data: { logId: 'l1', name: 'Fall 2026 Maintenance', description: 'd', items: [] },
};

describe('ChecklistAiSection', () => {
  it('seasonal button calls proposeChecklist with seasonal mode and shows preview', async () => {
    const user = userEvent.setup();
    proposeChecklist.mockResolvedValue(okResult);
    render(<ChecklistAiSection />);
    await user.click(screen.getByRole('button', { name: /Generate seasonal/i }));
    expect(proposeChecklist).toHaveBeenCalledWith(expect.objectContaining({ mode: 'seasonal' }));
    expect((await screen.findAllByText('Fall 2026 Maintenance')).length).toBeGreaterThan(0);
  });

  it('has no axe violations', async () => {
    render(<ChecklistAiSection />);
    await expectNoAxeViolations();
  });

  it('prompt dialog submits freeform mode with the typed prompt', async () => {
    const user = userEvent.setup();
    proposeChecklist.mockResolvedValue(okResult);
    render(<ChecklistAiSection />);
    await user.click(screen.getByRole('button', { name: /Generate from prompt/i }));
    await user.type(screen.getByRole('textbox'), 'Pre-winter cabin prep');
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    expect(proposeChecklist).toHaveBeenCalledWith({
      mode: 'freeform',
      freeFormPrompt: 'Pre-winter cabin prep',
    });
  });
});
