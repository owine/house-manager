type Props = {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
};

export function FormField({ label, htmlFor, error, hint, children }: Props) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <label
        htmlFor={htmlFor}
        style={{ display: 'block', fontWeight: 500, marginBottom: '0.25rem' }}
      >
        {label}
      </label>
      {children}
      {hint && !error && (
        <p style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
          {hint}
        </p>
      )}
      {error && (
        <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginTop: '0.25rem' }}>{error}</p>
      )}
    </div>
  );
}
