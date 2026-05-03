export class ChecklistNotFoundError extends Error {
  constructor() {
    super('Checklist not found');
    this.name = 'ChecklistNotFoundError';
  }
}

export function classifyAnthropicError(e: unknown): string {
  const msg = (e as Error)?.message ?? '';
  const status = (e as { status?: number })?.status;
  if (status === 429) return 'rate_limited';
  if (status && status >= 500 && status < 600) return 'upstream_5xx';
  if (
    msg.toLowerCase().includes('timeout') ||
    msg.toLowerCase().includes('timed out') ||
    msg.toLowerCase().includes('aborted')
  ) {
    return 'timeout';
  }
  if (msg.toLowerCase().includes('zoderror') || msg.toLowerCase().includes('schema')) {
    return 'schema_violation';
  }
  return 'unknown';
}

export function userFacingMessage(reason: string): string {
  switch (reason) {
    case 'rate_limited':
      return 'Service busy — try again in a minute.';
    case 'upstream_5xx':
      return "Couldn't reach AI service.";
    case 'timeout':
      return 'Took too long — try again.';
    case 'schema_violation':
      return 'Got an unexpected response — try again.';
    default:
      return 'Something went wrong generating suggestions.';
  }
}
