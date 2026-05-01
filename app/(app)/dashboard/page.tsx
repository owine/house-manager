import Link from 'next/link';
import { CompleteReminderForm } from '@/components/reminders/CompleteReminderForm';
import { auth } from '@/lib/auth';
import { quickStats, recentActivity, upcomingReminders } from '@/lib/dashboard/queries';

function relativeTime(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 86400 * 7) return `${Math.round(seconds / 86400)}d ago`;
  return date.toISOString().slice(0, 10);
}

export default async function Dashboard() {
  const [session, stats, activity, reminders] = await Promise.all([
    auth(),
    quickStats(),
    recentActivity(10),
    upcomingReminders(5),
  ]);

  return (
    <div>
      <h1 style={{ marginBottom: '1.5rem' }}>Hello, {session?.user?.name ?? 'there'}</h1>

      <div
        style={{
          display: 'flex',
          gap: '1.5rem',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
        }}
      >
        {/* Quick stats lane */}
        <section style={{ flex: '1 1 280px' }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Overview</h2>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <div
              style={{
                flex: '1 1 120px',
                padding: '1rem',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '2rem', fontWeight: 600, lineHeight: 1.1 }}>
                {stats.activeItems}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
                active items
              </div>
            </div>
            <div
              style={{
                flex: '1 1 120px',
                padding: '1rem',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '2rem', fontWeight: 600, lineHeight: 1.1 }}>
                {stats.vendors}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
                vendors
              </div>
            </div>
            <div
              style={{
                flex: '1 1 120px',
                padding: '1rem',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '2rem', fontWeight: 600, lineHeight: 1.1 }}>
                {stats.serviceThisYear}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
                service this year
              </div>
            </div>
          </div>
        </section>
        {/* Upcoming reminders lane */}
        <section style={{ flex: '1 1 280px' }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Upcoming reminders</h2>
          {reminders.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)', fontSize: '0.9rem' }}>
              No upcoming reminders — <Link href="/reminders/new">create one</Link>.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {reminders.map((r) => (
                <li
                  key={r.id}
                  style={{
                    padding: '0.5rem 0',
                    borderBottom: '1px solid var(--border)',
                    fontSize: '0.9rem',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '0.5rem',
                    }}
                  >
                    <Link href={`/reminders/${r.id}`} style={{ flex: 1, minWidth: 0 }}>
                      {r.title}
                    </Link>
                    <span
                      style={{
                        color: 'var(--fg-muted)',
                        fontSize: '0.8rem',
                        flexShrink: 0,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.nextDueOn.toISOString().slice(0, 10)}
                    </span>
                  </div>
                  <div style={{ marginTop: '0.25rem' }}>
                    <CompleteReminderForm
                      reminderId={r.id}
                      autoCreateServiceRecord={r.autoCreateServiceRecord}
                      hasItem={r.itemId != null}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Quick actions lane */}
        <section style={{ flex: '1 1 280px' }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Quick actions</h2>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link
              href="/items/new"
              style={{
                display: 'inline-block',
                padding: '0.5rem 1rem',
                border: '1px solid var(--border-strong)',
                borderRadius: '4px',
                textDecoration: 'none',
                fontSize: '0.9rem',
              }}
            >
              + Add item
            </Link>
            <Link
              href="/service/new"
              style={{
                display: 'inline-block',
                padding: '0.5rem 1rem',
                border: '1px solid var(--border-strong)',
                borderRadius: '4px',
                textDecoration: 'none',
                fontSize: '0.9rem',
              }}
            >
              + Log service
            </Link>
            <Link
              href="/vendors/new"
              style={{
                display: 'inline-block',
                padding: '0.5rem 1rem',
                border: '1px solid var(--border-strong)',
                borderRadius: '4px',
                textDecoration: 'none',
                fontSize: '0.9rem',
              }}
            >
              + Add vendor
            </Link>
            <Link
              href="/notes/new"
              style={{
                display: 'inline-block',
                padding: '0.5rem 1rem',
                border: '1px solid var(--border-strong)',
                borderRadius: '4px',
                textDecoration: 'none',
                fontSize: '0.9rem',
              }}
            >
              + Add note
            </Link>
          </div>
        </section>

        {/* Recent activity lane */}
        <section style={{ flex: '1 1 280px' }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Recent activity</h2>
          {activity.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)', fontSize: '0.9rem' }}>
              No activity yet — <Link href="/items/new">add an item to get started</Link>.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {activity.map((event) => (
                <li
                  key={`${event.kind}-${event.href}`}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '0.5rem',
                    padding: '0.4rem 0',
                    borderBottom: '1px solid var(--border)',
                    fontSize: '0.9rem',
                  }}
                >
                  <span style={{ flexShrink: 0 }}>{event.icon}</span>
                  <Link href={event.href} style={{ flex: 1, minWidth: 0 }}>
                    {event.label}
                  </Link>
                  <span
                    style={{
                      color: 'var(--fg-muted)',
                      fontSize: '0.8rem',
                      flexShrink: 0,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {relativeTime(event.occurredAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
