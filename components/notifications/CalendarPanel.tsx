import { CalendarPanelControls } from './CalendarPanelControls';
import { CalendarPanelGenerateButton } from './CalendarPanelGenerateButton';

type Props = {
  icsToken: string | null;
  appUrl: string;
};

export function CalendarPanel({ icsToken, appUrl }: Props) {
  if (!icsToken) {
    return (
      <div>
        <p style={{ color: 'var(--fg-muted)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
          Generate a calendar feed URL to subscribe to your reminders in your calendar app.
        </p>
        <CalendarPanelGenerateButton />
      </div>
    );
  }

  const calendarUrl = `${appUrl}/api/calendar/${icsToken}.ics`;

  return (
    <div>
      <p style={{ color: 'var(--fg-muted)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
        Subscribe to this iCalendar URL in your calendar app:
      </p>
      <CalendarPanelControls url={calendarUrl} />
    </div>
  );
}
