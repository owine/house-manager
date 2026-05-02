type Props = {
  header: React.ReactNode;
  maxWidth?: 'lg' | 'xl' | '2xl' | '3xl';
  children: React.ReactNode;
};

const MAX_WIDTH_CLASS: Record<NonNullable<Props['maxWidth']>, string> = {
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
};

export function FormPageShell({ header, maxWidth = '2xl', children }: Props) {
  return (
    <div className={`mx-auto ${MAX_WIDTH_CLASS[maxWidth]}`}>
      {header}
      {children}
    </div>
  );
}
