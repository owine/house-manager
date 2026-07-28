// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatTurnData, ChatTurnProposal } from '@/lib/chat/actions';
import type { ActionResult } from '@/lib/result';
import { ChatThread, type ThreadEntry } from './ChatThread';

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

// jsdom has no scrollIntoView implementation; ChatThread calls it on every
// thread-length change to keep the latest turn in view.
Element.prototype.scrollIntoView = vi.fn();

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
  replaceMock.mockClear();
});

function makeProposal(overrides: Partial<ChatTurnProposal> = {}): ChatTurnProposal {
  return {
    id: 'prop-1',
    kind: 'CREATE_SERVICE_RECORD',
    targetType: 'SERVICE_RECORD',
    targetId: null,
    payload: {
      kind: 'CREATE_SERVICE_RECORD',
      summary: { value: 'Reset water heater', source: 'user' },
      performedOn: { value: '2026-07-03', source: 'inferred' },
      notes: undefined,
      selfPerformed: true,
      targets: [],
    },
    status: 'PENDING',
    baseUpdatedAt: null,
    beforeSnapshot: null,
    ...overrides,
  };
}

function noopApply(): Promise<ActionResult<{ id: string }>> {
  return Promise.resolve({ ok: true, data: { id: 'x' } });
}
function noopRefresh(): Promise<ActionResult<{ proposal: ChatTurnProposal }>> {
  return Promise.resolve({ ok: true, data: { proposal: makeProposal() } });
}

describe('ChatThread', () => {
  it('renders the composer when askEnabled is true', () => {
    render(
      <ChatThread
        askEnabled={true}
        chatTurn={vi.fn()}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('hides the composer when askEnabled is false, but still renders a seeded thread and lets Accept apply', async () => {
    const applyProposal = vi.fn(noopApply);
    const initialThread: ThreadEntry[] = [
      { id: 'm1', role: 'user', content: 'The water heater needed a reset.' },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Got it — here is a proposal.',
        proposals: [makeProposal()],
      },
    ];
    const user = userEvent.setup();

    render(
      <ChatThread
        askEnabled={false}
        initialSessionId="session-1"
        initialThread={initialThread}
        chatTurn={vi.fn()}
        applyProposal={applyProposal}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );

    // Composer is gone.
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/dump a thought/i)).not.toBeInTheDocument();

    // Seeded messages and proposal card still render.
    expect(screen.getByText('The water heater needed a reset.')).toBeInTheDocument();
    expect(screen.getByText('Got it — here is a proposal.')).toBeInTheDocument();
    expect(screen.getByText('New service record')).toBeInTheDocument();

    // Accept still works with the flag off.
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(applyProposal).toHaveBeenCalledWith('prop-1'));
  });

  it('submits a turn via the injected chatTurn action and renders the reply plus proposal cards', async () => {
    const chatTurnResult: ActionResult<ChatTurnData> = {
      ok: true,
      data: {
        sessionId: 'session-new',
        messageId: 'm2',
        reply: 'Here is what I found.',
        proposals: [makeProposal({ id: 'prop-2' })],
      },
    };
    const chatTurn = vi.fn(() => Promise.resolve(chatTurnResult));
    const user = userEvent.setup();

    render(
      <ChatThread
        askEnabled={true}
        chatTurn={chatTurn}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );

    await user.type(
      screen.getByPlaceholderText(/dump a thought/i),
      'Water heater was reset today.',
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(chatTurn).toHaveBeenCalledWith({
        sessionId: undefined,
        messages: [{ role: 'user', content: 'Water heater was reset today.' }],
      }),
    );

    expect(await screen.findByText('Here is what I found.')).toBeInTheDocument();
    expect(screen.getByText('New service record')).toBeInTheDocument();
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/ask/session-new'));
  });
});
