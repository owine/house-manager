type Props = {
  header: React.ReactNode;
  filters?: React.ReactNode;
  empty?: React.ReactNode;
  isEmpty?: boolean;
  children: React.ReactNode;
};

export function ListPageShell({ header, filters, empty, isEmpty, children }: Props) {
  return (
    <div className="mx-auto max-w-7xl">
      {header}
      {filters && <div className="mb-4">{filters}</div>}
      {isEmpty && empty ? empty : children}
    </div>
  );
}
