type Props = {
  greeting: React.ReactNode;
  primary: React.ReactNode;
  secondary?: React.ReactNode[];
  tertiary?: React.ReactNode;
};

export function DashboardShell({ greeting, primary, secondary, tertiary }: Props) {
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {greeting}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {primary}
          {secondary && <div className="grid gap-4 sm:grid-cols-2">{secondary}</div>}
        </div>
        {tertiary && <aside>{tertiary}</aside>}
      </div>
    </div>
  );
}
