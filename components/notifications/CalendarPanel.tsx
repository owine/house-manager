import { CalendarPanelControls } from './CalendarPanelControls';
import { CalendarPanelGenerateButton } from './CalendarPanelGenerateButton';

type Props = {
  icsToken: string | null;
  appUrl: string;
};

export function CalendarPanel({ icsToken, appUrl }: Props) {
  if (!icsToken) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Generate a calendar feed URL to subscribe to your reminders in your calendar app.
        </p>
        <CalendarPanelGenerateButton />
      </div>
    );
  }

  const calendarUrl = `${appUrl}/api/calendar/${icsToken}.ics`;

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Subscribe to this iCalendar URL in your calendar app:
      </p>
      <CalendarPanelControls url={calendarUrl} />
    </div>
  );
}
