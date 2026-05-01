const DAY_MS = 86_400_000;

type Props = { nextDueOn: Date; active: boolean };

export function ReminderStatusBadge({ nextDueOn, active }: Props) {
  if (!active) {
    return (
      <span className="badge" style={{ color: 'var(--fg-muted)' }}>
        Inactive
      </span>
    );
  }
  const days = Math.floor((nextDueOn.getTime() - Date.now()) / DAY_MS);
  if (days < 0) {
    return (
      <span className="badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>
        Overdue
      </span>
    );
  }
  if (days <= 3) {
    return (
      <span className="badge" style={{ background: 'var(--bg-elevated)', color: 'var(--warning)' }}>
        Due soon
      </span>
    );
  }
  return (
    <span className="badge" style={{ color: 'var(--fg-muted)' }}>
      In {days}d
    </span>
  );
}
